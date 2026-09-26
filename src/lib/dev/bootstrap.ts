/**
 * One-shot local-dev bootstrap: seed officer@local.test and start the
 * in-process provisioning drain when running against embedded PGlite
 * (or DEV_LOGIN=1).
 *
 * Imported from plugin@auth so it runs once per SSR process after db/auth load.
 * Lazy-imports auth/drain to avoid circular init with db.
 */
import { sql } from "drizzle-orm";
import { db } from "~/lib/db";
import { isDevLoginEnabled, isEmbeddedDb } from "~/lib/db/mode";

declare global {
	var __portalDevBootstrapped: boolean | undefined;
	var __portalDrainTimer: ReturnType<typeof setInterval> | undefined;
}

/** `.local.test` — reserved testing TLD; better-auth rejects `*@localhost`. */
const OFFICER_EMAIL = "officer@local.test";
const OFFICER_PASSWORD = "local-dev";
const OFFICER_NAME = "Local Officer";

async function seedOfficer(): Promise<void> {
	const { rows: officers } = await db.execute<{ id: string }>(
		sql`SELECT id FROM "user" WHERE email = ${OFFICER_EMAIL} LIMIT 1`,
	);
	const existingId = officers[0]?.id;

	if (existingId) {
		const { rows: creds } = await db.execute<{ id: string }>(
			sql`SELECT id FROM account
          WHERE user_id = ${existingId}
            AND provider_id = 'credential'
          LIMIT 1`,
		);
		if (creds[0]) {
			await db.execute(
				sql`UPDATE "user"
            SET netid = 'officer',
                username = COALESCE(username, 'officer')
          WHERE id = ${existingId}`,
			);
			return;
		}
		// User row without a credential account: Better Auth 1.7 sign-up
		// created the user then failed linking (missing issuer column).
		await db.execute(sql`DELETE FROM "user" WHERE id = ${existingId}`);
	}

	const { auth } = await import("~/lib/auth");
	const result = await auth.api.signUpEmail({
		body: {
			email: OFFICER_EMAIL,
			password: OFFICER_PASSWORD,
			name: OFFICER_NAME,
		},
	});

	if (!result?.user) {
		console.warn(`[dev] failed to seed ${OFFICER_EMAIL}`);
		return;
	}

	await db.execute(
		sql`UPDATE "user" SET netid = 'officer', username = COALESCE(username, 'officer') WHERE id = ${result.user.id}`,
	);

	console.log(
		`[dev] seeded ${OFFICER_EMAIL} / ${OFFICER_PASSWORD} (admin)`,
	);
}

function startDrainLoop(): void {
	if (process.env.VITEST) return;
	if (globalThis.__portalDrainTimer) return;
	if (!isEmbeddedDb() && process.env.DEV_LOGIN !== "1") return;

	void (async () => {
		const { drainOnce } = await import("../../worker/provisioning");
		globalThis.__portalDrainTimer = setInterval(() => {
			void drainOnce().catch((err: unknown) => {
				console.error("[dev] drain error", err);
			});
		}, 1_000);
		// Unref so the timer does not keep the process alive in tests
		if (
			typeof globalThis.__portalDrainTimer === "object" &&
			globalThis.__portalDrainTimer &&
			"unref" in globalThis.__portalDrainTimer
		) {
			(
				globalThis.__portalDrainTimer as NodeJS.Timeout
			).unref?.();
		}
		console.log("[dev] in-process provisioning drain started");
	})();
}

/** Idempotent; safe to call from every request via plugin@auth. */
export async function ensureDevBootstrap(): Promise<void> {
	if (!isDevLoginEnabled()) return;
	if (globalThis.__portalDevBootstrapped) return;

	try {
		await seedOfficer();
		startDrainLoop();
		globalThis.__portalDevBootstrapped = true;
	} catch (err) {
		console.error("[dev] bootstrap failed", err);
	}
}
