import { component$ } from "@builder.io/qwik";
import { Link } from "@builder.io/qwik-city";
import { ActivityTable } from "~/components/dashboard/activity-table";
import { MeetingList } from "~/components/dashboard/meeting-list";
import { MetricCard } from "~/components/dashboard/metric-card";
import { OverviewHeader } from "~/components/dashboard/overview-header";
import { Panel } from "~/components/dashboard/panel";
import { ParticipationChart } from "~/components/dashboard/participation-chart";
import {
	CHART_WEEKS,
	type AnnouncementItem,
	type StaffShortcut,
	type TableRow,
} from "~/lib/dashboard/load";

export const StaffOverview = component$<{
	displayName: string;
	isPreview: boolean;
	metrics: {
		activeMembers: number;
		pendingSignups: number | null;
		alumniCandidates: number | null;
	};
	pendingSignups: TableRow[];
	alumniCandidates: TableRow[];
	announcements: AnnouncementItem[];
	bars: number[];
	shortcuts: StaffShortcut[];
	canReviewSignups: boolean;
	canReviewAlumni: boolean;
}>((props) => (
	<main class="p-xl grid gap-md">
		<OverviewHeader
			displayName={props.displayName}
			subtitle="Organization status and queues across the chapter."
			previewLabel={props.isPreview ? "Staff" : null}
		/>

		<section class="grid grid-cols-2 lg:grid-cols-4 gap-md">
			<MetricCard
				label="Active members"
				value={String(props.metrics.activeMembers)}
				note="Current roster"
			/>
			{props.metrics.pendingSignups !== null && (
				<MetricCard
					label="Pending signups"
					value={String(props.metrics.pendingSignups)}
					note="Awaiting review"
					tone={props.metrics.pendingSignups > 0 ? "warning" : "success"}
				/>
			)}
			{props.metrics.alumniCandidates !== null && (
				<MetricCard
					label="Alumni candidates"
					value={String(props.metrics.alumniCandidates)}
					note="Eligible transitions"
					tone={props.metrics.alumniCandidates > 0 ? "warning" : undefined}
				/>
			)}
			<MetricCard
				label="Announcements"
				value={String(props.announcements.length)}
				note="Latest published"
			/>
		</section>

		{props.shortcuts.length > 0 && (
			<Panel title="Quick links" meta="Admin tools">
				<div class="flex gap-sm flex-wrap">
					{props.shortcuts.map((link) => (
						<Link
							key={link.href}
							href={link.href}
							class="px-md py-sm rounded-control text-label border border-border bg-surface2 text-text1 no-underline"
						>
							{link.label}
						</Link>
					))}
				</div>
			</Panel>
		)}

		<section class="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-md">
			<Panel title="Chapter growth" meta={`${CHART_WEEKS}-week new members`}>
				<ParticipationChart
					bars={props.bars}
					startLabel="20 weeks ago"
					endLabel="this week"
				/>
			</Panel>
			<Panel title="Latest announcements" meta="View all">
				{props.announcements.length === 0 ? (
					<p class="text-text3 text-body-sm m-0">No announcements yet.</p>
				) : (
					<MeetingList items={props.announcements} />
				)}
			</Panel>
		</section>

		{props.canReviewSignups && (
			<Panel title="Pending signups" meta="Review queue">
				{props.pendingSignups.length === 0 ? (
					<p class="text-text3 text-body-sm m-0">No pending signups.</p>
				) : (
					<>
						<ActivityTable
							columns={["NetID", "Name", "Submitted"]}
							rows={props.pendingSignups}
						/>
						<p class="m-0 mt-sm">
							<Link
								href="/dashboard/admin/signups"
								class="text-accent text-label no-underline"
							>
								Open signup queue
							</Link>
						</p>
					</>
				)}
			</Panel>
		)}

		{props.canReviewAlumni && (
			<Panel title="Alumni candidates" meta="Transition queue">
				{props.alumniCandidates.length === 0 ? (
					<p class="text-text3 text-body-sm m-0">No alumni candidates.</p>
				) : (
					<>
						<ActivityTable
							columns={["NetID", "Name", "Grad year"]}
							rows={props.alumniCandidates}
						/>
						<p class="m-0 mt-sm">
							<Link
								href="/dashboard/admin/alumni"
								class="text-accent text-label no-underline"
							>
								Open alumni review
							</Link>
						</p>
					</>
				)}
			</Panel>
		)}
	</main>
));
