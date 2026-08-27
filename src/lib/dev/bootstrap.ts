/**
 * One-shot local-dev bootstrap: seed officer@localhost and start the
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
	const { rows } = await db.execute<{ count: number }>(
		sql`SELECT count(*)::int AS count FROM "user"`,
	);
	const count = rows[0]?.count ?? 0;
	if (count > 0) return;

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

	// Ensure netid is set for the officer (email prefix)
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
	globalThis.__portalDevBootstrapped = true;

	try {
		await seedOfficer();
		startDrainLoop();
	} catch (err) {
		console.error("[dev] bootstrap failed", err);
	}
}
