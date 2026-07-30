import { sql } from "drizzle-orm";
import { db } from "~/lib/db";
import { userRoles } from "~/lib/db/schema";

/** Serializes concurrent first logins (distinct from migrate.ts's lock id). */
const BOOTSTRAP_LOCK_ID = 727_002;

const ROLE_IDS = {
	member: "00000000-0000-0000-0000-000000000001",
	admin: "00000000-0000-0000-0000-000000000003",
} as const;

/**
 * Runs inside better-auth's databaseHooks.user.create.after. Race-safe via
 * xact advisory lock — first registered user (count == 1, the just-created
 * row) becomes admin + member; everyone else gets member. Phase 6 adds
 * provisioning-status wiring (signup answers + AD account status).
 */
export async function bootstrapUser(u: {
	id: string;
	email: string;
	netid: string | null;
	displayName: string | null;
}) {
	await db.transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_ID})`);

		const [{ count }] = (
			await tx.execute<{ count: number }>(
				sql`SELECT count(*)::int AS count FROM "user"`,
			)
		).rows;

		const grants =
			count === 1
				? [
						{ userId: u.id, roleId: ROLE_IDS.admin },
						{ userId: u.id, roleId: ROLE_IDS.member },
					]
				: [{ userId: u.id, roleId: ROLE_IDS.member }];

		await tx.insert(userRoles).values(grants).onConflictDoNothing();
	});
}
