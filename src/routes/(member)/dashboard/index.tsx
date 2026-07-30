import { component$ } from "@builder.io/qwik";
import { routeLoader$ } from "@builder.io/qwik-city";
import { and, desc, eq, gte } from "drizzle-orm";
import { ActivityTable } from "~/components/dashboard/activity-table";
import { MeetingList } from "~/components/dashboard/meeting-list";
import { MetricCard } from "~/components/dashboard/metric-card";
import { Panel } from "~/components/dashboard/panel";
import { ParticipationChart } from "~/components/dashboard/participation-chart";
import { db } from "~/lib/db";
import { contentItems, memberProfiles, user, userRoles } from "~/lib/db/schema";
import { getPermissions } from "~/lib/rbac/guards";
import type { PortalSession } from "~/lib/types";

const OFFICER_ROLE_ID = "00000000-0000-0000-0000-000000000002";
const CHART_WEEKS = 20;

export const useDashboard = routeLoader$(async (event) => {
	const session = event.sharedMap.get("session") as PortalSession;
	const perms = await getPermissions(event);

	const [[profile], officers, announcements, rosterDates] = await Promise.all([
		db
			.select({
				status: memberProfiles.status,
				adProvisioningStatus: memberProfiles.adProvisioningStatus,
				answers: memberProfiles.answers,
			})
			.from(memberProfiles)
			.where(eq(memberProfiles.userId, session.user.id))
			.limit(1),
		db
			.select({ name: user.name, netid: user.netid })
			.from(userRoles)
			.innerJoin(user, eq(userRoles.userId, user.id))
			.where(eq(userRoles.roleId, OFFICER_ROLE_ID))
			.limit(8),
		db
			.select({
				id: contentItems.id,
				title: contentItems.title,
				publishedAt: contentItems.publishedAt,
			})
			.from(contentItems)
			.where(
				and(
					eq(contentItems.status, "published"),
					eq(contentItems.type, "announcement"),
				),
			)
			.orderBy(desc(contentItems.publishedAt))
			.limit(5),
		db
			.select({ createdAt: memberProfiles.createdAt })
			.from(memberProfiles)
			.where(
				gte(
					memberProfiles.createdAt,
					new Date(Date.now() - CHART_WEEKS * 7 * 86_400_000),
				),
			),
	]);

	const answers = (profile?.answers ?? {}) as Record<string, unknown>;
	const sigInterest = Array.isArray(answers.sig_interest)
		? answers.sig_interest.length
		: 0;

	// Roster growth: new profiles per week for the last CHART_WEEKS weeks
	const bars = new Array<number>(CHART_WEEKS).fill(0);
	const now = Date.now();
	for (const row of rosterDates) {
		const weekIndex = Math.floor(
			(now - new Date(row.createdAt).getTime()) / (7 * 86_400_000),
		);
		if (weekIndex >= 0 && weekIndex < CHART_WEEKS)
			bars[CHART_WEEKS - 1 - weekIndex]++;
	}

	const provisioningNote =
		profile?.adProvisioningStatus === "provisioned"
			? { note: "Account provisioned", tone: "success" as const }
			: profile?.adProvisioningStatus === "failed"
				? {
						note: "Provisioning failed — contact an officer",
						tone: "error" as const,
					}
				: { note: "Provisioning pending", tone: "warning" as const };

	// Minimal DTO: only first-name display, sig count, grad year, officer netids/names.
	// Excludes entra_oid, email, uin, restricted demographic answers.
	void perms; // reserved for future perms-driven rendering

	return {
		displayName: session.user.name,
		metrics: {
			membership: profile?.status === "active" ? "Active" : "Inactive",
			provisioning: provisioningNote,
			sigCount: sigInterest,
			gradYear:
				typeof answers.grad_year === "number" ? answers.grad_year : null,
		},
		officers: officers.map((o) => ({ cells: [o.netid ?? "—", o.name] })),
		announcements: announcements.map((a) => ({
			id: a.id,
			date: a.publishedAt ?? new Date(0),
			title: a.title,
			subtitle: "Chapter announcement",
		})),
		bars,
	};
});

export default component$(() => {
	const data = useDashboard();

	return (
		<main class="p-xl grid gap-md">
			<header class="mb-sm">
				<p class="m-0 text-accent text-caption font-semibold uppercase tracking-wider">
					{new Date().toLocaleDateString("en-US", {
						weekday: "long",
						month: "long",
						day: "numeric",
					})}
				</p>
				<h1 class="m-0 mt-2xs font-display text-heading">
					Hello, {data.value.displayName.split(" ")[0]}.
				</h1>
				<p class="m-0 mt-2xs text-text2 text-body-sm">
					Here is what is happening across the chapter.
				</p>
			</header>

			<section class="grid grid-cols-2 lg:grid-cols-4 gap-md">
				<MetricCard
					label="Membership"
					value={data.value.metrics.membership}
					note={
						data.value.metrics.membership === "Active"
							? "Verified for this season"
							: "Check with an officer"
					}
					tone={
						data.value.metrics.membership === "Active" ? "success" : "warning"
					}
				/>
				<MetricCard
					label="Account"
					value={
						data.value.metrics.provisioning.tone === "success"
							? "Ready"
							: "Pending"
					}
					note={data.value.metrics.provisioning.note}
					tone={data.value.metrics.provisioning.tone}
				/>
				<MetricCard
					label="SIG interests"
					value={String(data.value.metrics.sigCount)}
					note="From your signup profile"
				/>
				<MetricCard
					label="Graduation"
					value={
						data.value.metrics.gradYear
							? String(data.value.metrics.gradYear)
							: "—"
					}
					note="Expected year"
				/>
			</section>

			<section class="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-md">
				<Panel title="Chapter growth" meta={`${CHART_WEEKS}-week new members`}>
					<ParticipationChart
						bars={data.value.bars}
						startLabel="20 weeks ago"
						endLabel="this week"
					/>
				</Panel>
				<Panel title="Latest announcements" meta="View all">
					{data.value.announcements.length === 0 ? (
						<p class="text-text3 text-body-sm m-0">No announcements yet.</p>
					) : (
						<MeetingList items={data.value.announcements} />
					)}
				</Panel>
			</section>

			<Panel title="Officer contacts" meta="Chapter board">
				<ActivityTable columns={["NetID", "Name"]} rows={data.value.officers} />
			</Panel>
		</main>
	);
});
