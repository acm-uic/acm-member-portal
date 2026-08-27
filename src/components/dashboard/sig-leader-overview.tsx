import { component$ } from "@builder.io/qwik";
import { ActivityTable } from "~/components/dashboard/activity-table";
import { MeetingList } from "~/components/dashboard/meeting-list";
import { OverviewHeader } from "~/components/dashboard/overview-header";
import { Panel } from "~/components/dashboard/panel";
import type {
	AnnouncementItem,
	SigInterestGroup,
} from "~/lib/dashboard/load";

export const SigLeaderOverview = component$<{
	displayName: string;
	isPreview: boolean;
	ledSigs: SigInterestGroup[];
	announcements: AnnouncementItem[];
}>((props) => (
	<main class="p-xl grid gap-md">
		<OverviewHeader
			displayName={props.displayName}
			subtitle="Members interested in the SIGs you lead."
			previewLabel={props.isPreview ? "SIG Leader" : null}
		/>

		{props.ledSigs.length === 0 ? (
			<Panel title="Your SIGs" meta="No assignments">
				<p class="text-text3 text-body-sm m-0">
					{props.isPreview
						? "Preview mode: you are not assigned as a SIG leader, so there is no interest list to show. Assign SIG leadership on the Members admin page to populate this view."
						: "You have the SIG Leader role, but no SIGs are assigned yet. Ask an officer or admin to assign the SIGs you lead."}
				</p>
			</Panel>
		) : (
			props.ledSigs.map((sig) => (
				<Panel
					key={sig.sigId}
					title={sig.displayName}
					meta={`${sig.interestCount} interested`}
				>
					{sig.members.length === 0 ? (
						<p class="text-text3 text-body-sm m-0">
							No active members have marked interest yet.
						</p>
					) : (
						<ActivityTable
							columns={["NetID", "Name", "Grad year"]}
							rows={sig.members}
						/>
					)}
				</Panel>
			))
		)}

		<Panel title="Latest announcements" meta="Chapter">
			{props.announcements.length === 0 ? (
				<p class="text-text3 text-body-sm m-0">No announcements yet.</p>
			) : (
				<MeetingList items={props.announcements} />
			)}
		</Panel>
	</main>
));
