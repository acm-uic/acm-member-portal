import {
	claimNext,
	markFailed,
	markProvisioned,
} from "../lib/provisioning/outbox";
import { MAX_ATTEMPTS } from "../lib/provisioning/backoff";
import { sendCredentialEmail } from "../lib/mail/templates";

const API_URL = process.env.WINDOWS_API_URL!;
const API_TOKEN = process.env.WINDOWS_API_TOKEN!;

/**
 * Drain one provisioning event. Returns false when the queue is empty
 * (caller backs off). Idempotency lives API-side: the Windows API keys on
 * sAMAccountName (netid) and returns existed:true on replay; in that case
 * no password is returned and no email is sent.
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
		const res = await fetchImpl(`${API_URL}/users`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${API_TOKEN}`,
			},
			body: JSON.stringify(event.payload),
			signal: AbortSignal.timeout(30_000),
		});

		if (!res.ok) {
			throw new Error(
				`Provisioning API ${res.status}: ${(await res.text()).slice(0, 500)}`,
			);
		}

		const body = (await res.json()) as {
			samAccountName: string;
			existed: boolean;
			oneTimePassword?: string;
		};

		if (body.oneTimePassword) {
			const payload = event.payload as { email: string };
			await sendCredentialEmail({
				to: payload.email,
				netid: body.samAccountName,
				oneTimePassword: body.oneTimePassword,
			});
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
