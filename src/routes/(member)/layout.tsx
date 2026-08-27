import { component$, Slot } from "@builder.io/qwik";
import { routeLoader$, type RequestHandler } from "@builder.io/qwik-city";
import { eq } from "drizzle-orm";
import { Sidebar } from "~/components/app-shell/sidebar";
import { loadUserRoleKeys } from "~/lib/dashboard/load";
import {
	DASHBOARD_VIEW_COOKIE,
	resolveDashboardView,
} from "~/lib/dashboard/view";
import { db } from "~/lib/db";
import { memberProfiles } from "~/lib/db/schema";
import { resolvePermissions } from "~/lib/rbac";
import type { PortalSession } from "~/lib/types";

/** Gate: any authenticated user. */
export const onRequest: RequestHandler = ({ sharedMap, redirect, url }) => {
	const session = sharedMap.get("session") as PortalSession | null;
	if (!session?.user) {
		throw redirect(302, `/login?next=${encodeURIComponent(url.pathname)}`);
	}
};

/** Shell data — own, non-sensitive display values only (serialized is fine). */
export const useShellData = routeLoader$(async (event) => {
	const session = event.sharedMap.get("session") as PortalSession;
	const [perms, profileRows, roleKeys] = await Promise.all([
		resolvePermissions(session.user.id),
		db
			.select({ status: memberProfiles.status })
			.from(memberProfiles)
			.where(eq(memberProfiles.userId, session.user.id))
			.limit(1),
		loadUserRoleKeys(session.user.id),
	]);
	const profile = profileRows[0];
	const cookieValue = event.cookie.get(DASHBOARD_VIEW_COOKIE)?.value;
	const { view, canPreview } = resolveDashboardView(roleKeys, cookieValue);

	return {
		userName: session.user.name,
		userStatus: profile?.status === "active" ? "Active member" : "Member",
		isAdmin: perms.has("admin.access"),
		canPreviewDashboard: canPreview,
		dashboardView: view,
	};
});

export default component$(() => {
	const shell = useShellData();
	return (
		<div class="flex min-h-screen">
			<Sidebar
				userName={shell.value.userName}
				userStatus={shell.value.userStatus}
				isAdmin={shell.value.isAdmin}
				canPreviewDashboard={shell.value.canPreviewDashboard}
				dashboardView={shell.value.dashboardView}
			/>
			<div class="flex-1 min-w-0">
				<Slot />
			</div>
		</div>
	);
});
