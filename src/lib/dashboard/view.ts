/** Overview personas rendered on `/dashboard`. */
export const DASHBOARD_VIEWS = [
	"staff",
	"sig_leader",
	"member",
	"alumni",
] as const;

export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export const DASHBOARD_VIEW_COOKIE = "dashboard_view";

/** Roles that unlock the shared Staff overview + view picker. */
export const STAFF_ROLE_KEYS = ["admin", "officer", "moderator"] as const;

export function isStaffRoleKey(key: string): boolean {
	return (STAFF_ROLE_KEYS as readonly string[]).includes(key);
}

export function isStaff(roleKeys: readonly string[]): boolean {
	return roleKeys.some(isStaffRoleKey);
}

export function isDashboardView(value: unknown): value is DashboardView {
	return (
		typeof value === "string" &&
		(DASHBOARD_VIEWS as readonly string[]).includes(value)
	);
}

/**
 * Default overview from the user's actual roles.
 * Priority: staff → sig_leader → alumni → member.
 */
export function defaultDashboardView(
	roleKeys: readonly string[],
): DashboardView {
	if (isStaff(roleKeys)) return "staff";
	if (roleKeys.includes("sig_leader")) return "sig_leader";
	if (roleKeys.includes("alumni")) return "alumni";
	return "member";
}

/**
 * Resolve the active overview view.
 * Staff may preview any persona via cookie; non-Staff always get their default.
 */
export function resolveDashboardView(
	roleKeys: readonly string[],
	cookieValue: string | null | undefined,
): { view: DashboardView; canPreview: boolean; isPreview: boolean } {
	const canPreview = isStaff(roleKeys);
	const fallback = defaultDashboardView(roleKeys);
	if (!canPreview) {
		return { view: fallback, canPreview: false, isPreview: false };
	}
	if (isDashboardView(cookieValue)) {
		return {
			view: cookieValue,
			canPreview: true,
			isPreview: cookieValue !== fallback,
		};
	}
	return { view: fallback, canPreview: true, isPreview: false };
}
