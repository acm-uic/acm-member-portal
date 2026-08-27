import { component$ } from "@builder.io/qwik";
import { ActivityTable } from "~/components/dashboard/activity-table";
import { MeetingList } from "~/components/dashboard/meeting-list";
import { MetricCard } from "~/components/dashboard/metric-card";
import { OverviewHeader } from "~/components/dashboard/overview-header";
import { Panel } from "~/components/dashboard/panel";
import type {
	AnnouncementItem,
	PersonalMetrics,
	TableRow,
} from "~/lib/dashboard/load";

export const MemberOverview = component$<{
	displayName: string;
	isPreview: boolean;
	metrics: PersonalMetrics;
	announcements: AnnouncementItem[];
	officers: TableRow[];
}>((props) => (
	<main class="p-xl grid gap-md">
		<OverviewHeader
			displayName={props.displayName}
			subtitle="Your membership status, announcements, and officer contacts."
			previewLabel={props.isPreview ? "Member" : null}
		/>

		<section class="grid grid-cols-2 lg:grid-cols-4 gap-md">
			<MetricCard
				label="Membership"
				value={props.metrics.membership}
				note={
					props.metrics.membership === "Active"
						? "Verified for this season"
						: "Check with an officer"
				}
				tone={props.metrics.membership === "Active" ? "success" : "warning"}
			/>
			<MetricCard
				label="Account"
				value={
					props.metrics.provisioning.tone === "success" ? "Ready" : "Pending"
				}
				note={props.metrics.provisioning.note}
				tone={props.metrics.provisioning.tone}
			/>
			<MetricCard
				label="SIG interests"
				value={String(props.metrics.sigCount)}
				note="From your signup profile"
			/>
			<MetricCard
				label="Graduation"
				value={
					props.metrics.gradYear ? String(props.metrics.gradYear) : "—"
				}
				note="Expected year"
			/>
		</section>

		<Panel title="Latest announcements" meta="View all">
			{props.announcements.length === 0 ? (
				<p class="text-text3 text-body-sm m-0">No announcements yet.</p>
			) : (
				<MeetingList items={props.announcements} />
			)}
		</Panel>

		<Panel title="Officer contacts" meta="Chapter board">
			<ActivityTable columns={["NetID", "Name"]} rows={props.officers} />
		</Panel>
	</main>
));
