import type { PermissionKey } from "./permissions";

export const ADMIN_ROLE_KEY = "admin";

export interface RoleChangeContext {
	actorUserId: string;
	actorRoleKeys: string[];
	actorPermissions: ReadonlySet<PermissionKey> | readonly string[];
	targetUserId: string;
	/** Role keys the target currently has (saved, not pending). */
	targetRoleKeys: string[];
	/** User ids that currently hold the admin role. */
	adminUserIds: string[];
	roleKey: string;
	/** True when adding the role, false when removing it. */
	assign: boolean;
}

function hasPerm(
	perms: RoleChangeContext["actorPermissions"],
	key: PermissionKey,
): boolean {
	if (perms instanceof Set) return perms.has(key);
	return (perms as readonly string[]).includes(key);
}

/**
 * Why this role add/remove cannot proceed, or null if it is allowed.
 * Shared by the members page (click-time) and the save action (server).
 */
export function roleChangeBlocked(ctx: RoleChangeContext): string | null {
	if (!hasPerm(ctx.actorPermissions, "members.manage")) {
		return "You don't have permission to change member roles.";
	}

	if (ctx.roleKey === ADMIN_ROLE_KEY) {
		const actorIsAdmin = ctx.actorRoleKeys.includes(ADMIN_ROLE_KEY);
		if (!actorIsAdmin) {
			return ctx.assign
				? "You don't have permission to assign the Admin role."
				: "You don't have permission to remove the Admin role.";
		}

		if (
			!ctx.assign &&
			ctx.targetUserId === ctx.actorUserId &&
			ctx.targetRoleKeys.includes(ADMIN_ROLE_KEY)
		) {
			return "You can't remove the Admin role from your own account.";
		}

		if (!ctx.assign && ctx.targetRoleKeys.includes(ADMIN_ROLE_KEY)) {
			const remaining = ctx.adminUserIds.filter((id) => id !== ctx.targetUserId);
			if (remaining.length === 0) {
				return "You can't remove the last Admin. Assign Admin to someone else first.";
			}
		}
	}

	return null;
}
