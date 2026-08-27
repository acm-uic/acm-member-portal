import { component$ } from "@builder.io/qwik";
import { routeLoader$ } from "@builder.io/qwik-city";
import { AlumniOverview } from "~/components/dashboard/alumni-overview";
import { MemberOverview } from "~/components/dashboard/member-overview";
import { SigLeaderOverview } from "~/components/dashboard/sig-leader-overview";
import { StaffOverview } from "~/components/dashboard/staff-overview";
import {
	loadMemberLikeDashboard,
	loadSigLeaderDashboard,
	loadStaffDashboard,
	loadUserRoleKeys,
} from "~/lib/dashboard/load";
import {
	DASHBOARD_VIEW_COOKIE,
	resolveDashboardView,
} from "~/lib/dashboard/view";
import { getPermissions } from "~/lib/rbac/guards";
import type { PortalSession } from "~/lib/types";

export const useDashboard = routeLoader$(async (event) => {
	const session = event.sharedMap.get("session") as PortalSession;
	const [perms, roleKeys] = await Promise.all([
		getPermissions(event),
		loadUserRoleKeys(session.user.id),
	]);

	const cookieValue = event.cookie.get(DASHBOARD_VIEW_COOKIE)?.value;
	const { view, canPreview, isPreview } = resolveDashboardView(
		roleKeys,
		cookieValue,
	);

	const displayName = session.user.name;

	if (view === "staff") {
		const staff = await loadStaffDashboard(perms);
		return {
			view,
			canPreview,
			isPreview,
			displayName,
			staff,
			sigLeader: null,
			member: null,
		};
	}

	if (view === "sig_leader") {
		const sigLeader = await loadSigLeaderDashboard(session.user.id);
		return {
			view,
			canPreview,
			isPreview,
			displayName,
			staff: null,
			sigLeader,
			member: null,
		};
	}

	const member = await loadMemberLikeDashboard(session.user.id);
	return {
		view,
		canPreview,
		isPreview,
		displayName,
		staff: null,
		sigLeader: null,
		member,
	};
});

export default component$(() => {
	const data = useDashboard();
	const d = data.value;

	if (d.view === "staff" && d.staff) {
		return (
			<StaffOverview
				displayName={d.displayName}
				isPreview={d.isPreview}
				metrics={d.staff.metrics}
				pendingSignups={d.staff.pendingSignups}
				alumniCandidates={d.staff.alumniCandidates}
				announcements={d.staff.announcements}
				bars={d.staff.bars}
				shortcuts={d.staff.shortcuts}
				canReviewSignups={d.staff.canReviewSignups}
				canReviewAlumni={d.staff.canReviewAlumni}
			/>
		);
	}

	if (d.view === "sig_leader" && d.sigLeader) {
		return (
			<SigLeaderOverview
				displayName={d.displayName}
				isPreview={d.isPreview}
				ledSigs={d.sigLeader.ledSigs}
				announcements={d.sigLeader.announcements}
			/>
		);
	}

	if (d.view === "alumni" && d.member) {
		return (
			<AlumniOverview
				displayName={d.displayName}
				isPreview={d.isPreview}
				metrics={d.member.metrics}
				announcements={d.member.announcements}
			/>
		);
	}

	if (d.member) {
		return (
			<MemberOverview
				displayName={d.displayName}
				isPreview={d.isPreview}
				metrics={d.member.metrics}
				announcements={d.member.announcements}
				officers={d.member.officers}
			/>
		);
	}

	return (
		<main class="p-xl">
			<p class="text-text3">Unable to load dashboard.</p>
		</main>
	);
});
