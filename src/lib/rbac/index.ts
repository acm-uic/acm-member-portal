import { eq, sql } from "drizzle-orm";
import { db, pool } from "~/lib/db";
import { rolePermissions, userRoles } from "~/lib/db/schema";
import type { PermissionKey } from "./permissions";

/**
 * Per-role permission sets, cached in-process. Invalidated two ways:
 *  1. pg_notify('rbac','bump') from any replica (cross-replica, sub-second)
 *  2. 5s TTL backstop (self-healing if LISTEN drops)
 * At this scale (17 permissions × 6 roles) the cached aggregate is a tiny
 * single-indexed read; per-user resolution is a second indexed read.
 */
const TTL_MS = 5_000;

let cache: { at: number; byRole: Map<string, Set<PermissionKey>> } | null =
	null;
let listenerStarted = false;

function ensureListener(): void {
	if (listenerStarted) return;
	listenerStarted = true;
	void (async () => {
		try {
			const client = await pool.connect();
			await client.query("LISTEN rbac");
			client.on("notification", () => {
				cache = null;
			});
			client.on("error", () => {
				cache = null;
				listenerStarted = false; // reconnect on next resolve
				client.release();
			});
		} catch {
			listenerStarted = false; // LISTEN unavailable — TTL backstop covers us
		}
	})();
}

async function rolePermissionSets(): Promise<Map<string, Set<PermissionKey>>> {
	ensureListener();
	if (cache && Date.now() - cache.at < TTL_MS) return cache.byRole;
	const rows = await db
		.select({
			roleId: rolePermissions.roleId,
			permissionKey: rolePermissions.permissionKey,
		})
		.from(rolePermissions);
	const byRole = new Map<string, Set<PermissionKey>>();
	for (const row of rows) {
		const set = byRole.get(row.roleId) ?? new Set<PermissionKey>();
		set.add(row.permissionKey as PermissionKey);
		byRole.set(row.roleId, set);
	}
	cache = { at: Date.now(), byRole };
	return byRole;
}

/** Pure union — exported for unit tests. */
export function unionPermissions(
	memberships: readonly string[],
	sets: ReadonlyMap<string, Set<PermissionKey>>,
): Set<PermissionKey> {
	const out = new Set<PermissionKey>();
	for (const roleId of memberships) {
		for (const key of sets.get(roleId) ?? []) out.add(key);
	}
	return out;
}

export async function resolvePermissions(
	userId: string,
): Promise<Set<PermissionKey>> {
	const [sets, memberships] = await Promise.all([
		rolePermissionSets(),
		db
			.select({ roleId: userRoles.roleId })
			.from(userRoles)
			.where(eq(userRoles.userId, userId)),
	]);
	return unionPermissions(
		memberships.map((m) => m.roleId),
		sets,
	);
}

/** Call after any role_permissions edit: local reset + cross-replica broadcast. */
export async function bumpRbac(): Promise<void> {
	cache = null;
	await db.execute(sql`SELECT pg_notify('rbac', 'bump')`);
}
