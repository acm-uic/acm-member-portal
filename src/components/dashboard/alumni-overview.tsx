import { component$ } from "@builder.io/qwik";
import { Link } from "@builder.io/qwik-city";
import { MeetingList } from "~/components/dashboard/meeting-list";
import { MetricCard } from "~/components/dashboard/metric-card";
import { OverviewHeader } from "~/components/dashboard/overview-header";
import { Panel } from "~/components/dashboard/panel";
import type {
	AnnouncementItem,
	PersonalMetrics,
} from "~/lib/dashboard/load";

export const AlumniOverview = component$<{
	displayName: string;
	isPreview: boolean;
	metrics: PersonalMetrics;
	announcements: AnnouncementItem[];
}>((props) => (
	<main class="p-xl grid gap-md">
		<OverviewHeader
			displayName={props.displayName}
			subtitle="Stay connected with the chapter as an alum."
			previewLabel={props.isPreview ? "Alumni" : null}
		/>

		<section class="grid grid-cols-2 lg:grid-cols-4 gap-md">
			<MetricCard
				label="Status"
				value="Alumni"
				note="Chapter alumni roster"
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
				label="Graduation"
				value={
					props.metrics.gradYear ? String(props.metrics.gradYear) : "—"
				}
				note="Class year"
			/>
			<MetricCard
				label="Profile"
				value="Update"
				note="Keep your details current"
			/>
		</section>

		<section class="grid grid-cols-1 lg:grid-cols-2 gap-md">
			<Panel title="Alumni network" meta="Coming soon">
				<p class="text-text3 text-body-sm m-0">
					A way to find and reconnect with other ACM@UIC alumni is on the way.
				</p>
			</Panel>
			<Panel title="Opportunities" meta="Coming soon">
				<p class="text-text3 text-body-sm m-0">
					Job postings and mentorship opportunities for alumni will appear here.
				</p>
			</Panel>
		</section>

		<Panel title="Latest announcements" meta="Chapter">
			{props.announcements.length === 0 ? (
				<p class="text-text3 text-body-sm m-0">No announcements yet.</p>
			) : (
				<MeetingList items={props.announcements} />
			)}
		</Panel>

		<p class="m-0">
			<Link
				href="/dashboard/profile"
				class="text-accent text-label no-underline"
			>
				Edit your profile
			</Link>
		</p>
	</main>
));
