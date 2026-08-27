import {
	claimNext,
	markFailed,
	markProvisioned,
} from "../lib/provisioning/outbox";
import { MAX_ATTEMPTS } from "../lib/provisioning/backoff";
import { sendCredentialEmail } from "../lib/mail/templates";
import { randomBytes } from "node:crypto";

/**
 * Drain one provisioning event. Returns false when the queue is empty
 * (caller backs off). Idempotency lives API-side: the Windows API keys on
 * sAMAccountName (signup username) and returns existed:true on replay; in that
 * case no password is returned and no email is sent.
 *
 * When WINDOWS_API_URL is unset, stubs AD creation locally (dev / PGlite).
 */
export async function drainOnce(
	fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
	const event = await claimNext();
	if (!event) return false;

	// Crash-loop guard: a repeatedly reclaimed event exhausts its attempts
	// without ever reaching markFailed — dead-letter it instead of re-POSTing.
	if (event.attempts >= MAX_ATTEMPTS) {
		await markFailed(
			event.id,
			"Exceeded max attempts (crash-loop reaper)",
			event.attempts,
		);
		return true;
	}

	try {
		const payload = event.payload as {
			netid: string;
			username?: string;
			firstName: string;
			lastName: string;
			preferredName?: string;
			email: string;
			displayName: string;
			uin?: string;
			department?: string;
			company?: string;
			eventId: string;
		};
		const username = payload.username || payload.netid;

		const body = process.env.WINDOWS_API_URL
			? await callWindowsApi({ ...payload, username }, fetchImpl)
			: stubProvision({ username });

		if (body.oneTimePassword) {
			await sendCredentialEmail({
				to: payload.email,
				username: body.samAccountName,
				oneTimePassword: body.oneTimePassword,
			});

			// Local-only: create an email/password user so the applicant can
			// sign in without Entra (password = one-time password from mail stub).
			if (!process.env.WINDOWS_API_URL) {
				await seedLocalMemberLogin({
					email: payload.email,
					name: payload.displayName,
					password: body.oneTimePassword,
					netid: payload.netid,
					username,
					uin: payload.uin,
					firstName: payload.firstName,
					lastName: payload.lastName,
					preferredName: payload.preferredName,
				});
			}
		}

		await markProvisioned(event.id);
	} catch (err) {
		await markFailed(
			event.id,
			err instanceof Error ? err.message : String(err),
			event.attempts + 1,
		);
	}

	return true;
}

function stubProvision(payload: { username: string }): {
	samAccountName: string;
	existed: boolean;
	oneTimePassword: string;
} {
	const oneTimePassword = `dev-${randomBytes(6).toString("hex")}`;
	console.log(
		`[provision stub] created ${payload.username} (OTP written via mail stub)`,
	);
	return {
		samAccountName: payload.username,
		existed: false,
		oneTimePassword,
	};
}

async function seedLocalMemberLogin(args: {
	email: string;
	name: string;
	password: string;
	netid: string;
	username: string;
	uin?: string;
	firstName: string;
	lastName: string;
	preferredName?: string;
}): Promise<void> {
	try {
		const { auth } = await import("../lib/auth");
		const { eq } = await import("drizzle-orm");
		const { db } = await import("../lib/db");
		const { user } = await import("../lib/db/schema");

		const [existing] = await db
			.select({ id: user.id })
			.from(user)
			.where(eq(user.email, args.email))
			.limit(1);
		if (existing) return;

		const result = await auth.api.signUpEmail({
			body: {
				email: args.email,
				password: args.password,
				name: args.name,
				netid: args.netid,
				username: args.username,
				uin: args.uin,
				firstName: args.firstName,
				lastName: args.lastName,
				preferredName: args.preferredName,
			} as {
				email: string;
				password: string;
				name: string;
				netid: string;
				username: string;
				uin?: string;
				firstName: string;
				lastName: string;
				preferredName?: string;
			},
		});
		if (result?.user) {
			await db
				.update(user)
				.set({
					netid: args.netid,
					username: args.username,
					uin: args.uin ?? null,
					firstName: args.firstName,
					lastName: args.lastName,
					preferredName: args.preferredName ?? null,
				})
				.where(eq(user.id, result.user.id));
			console.log(
				`[dev] local member login: ${args.email} (password in .data/mail/)`,
			);
		}
	} catch (err) {
		console.warn("[dev] could not seed member login", err);
	}
}

async function callWindowsApi(
	payload: {
		netid: string;
		username: string;
		firstName: string;
		lastName: string;
		preferredName?: string;
		email: string;
		displayName: string;
		uin?: string;
		department?: string;
		company?: string;
		eventId: string;
	},
	fetchImpl: typeof fetch,
): Promise<{
	samAccountName: string;
	existed: boolean;
	oneTimePassword?: string;
}> {
	const API_URL = process.env.WINDOWS_API_URL!;
	const API_TOKEN = process.env.WINDOWS_API_TOKEN!;

	const res = await fetchImpl(`${API_URL}/users`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${API_TOKEN}`,
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(30_000),
	});

	if (!res.ok) {
		throw new Error(
			`Provisioning API ${res.status}: ${(await res.text()).slice(0, 500)}`,
		);
	}

	return (await res.json()) as {
		samAccountName: string;
		existed: boolean;
		oneTimePassword?: string;
	};
}
