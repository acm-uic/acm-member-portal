import type { PermissionKey } from "./permissions";

/** Pure union of permission keys across role memberships. */
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
