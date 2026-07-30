import { component$ } from "@builder.io/qwik";
import type { MetricTone } from "./metric-card";

export interface DatedRow {
	id: string;
	date: Date;
	title: string;
	subtitle: string;
	status?: { text: string; tone: MetricTone };
}

const TONE_CLASS = {
	success: "bg-success-bg text-success",
	warning: "bg-warning-bg text-warning",
	error: "bg-error-bg text-error",
} as const;

/** Date-chip row list (archetype "Next meetings" rows; reused for announcements). */
export const MeetingList = component$<{ items: DatedRow[] }>((props) => (
	<div class="grid">
		{props.items.map((item) => {
			const date = new Date(item.date);
			return (
				<div
					key={item.id}
					class="grid grid-cols-[42px_1fr_auto] gap-sm items-center py-sm border-t border-border"
				>
					<div class="w-[42px] h-[42px] grid place-items-center rounded-control bg-accent-subtle text-accent text-caption font-bold leading-tight text-center">
						{date.getDate()}
						<br />
						{date.toLocaleString("en-US", { month: "short" }).toUpperCase()}
					</div>
					<div class="min-w-0">
						<strong class="block text-body-sm text-text1 truncate">
							{item.title}
						</strong>
						<span class="block text-caption text-text3">{item.subtitle}</span>
					</div>
					{item.status && (
						<span
							class={`px-sm py-2xs rounded-element text-caption font-semibold ${TONE_CLASS[item.status.tone]}`}
						>
							{item.status.text}
						</span>
					)}
				</div>
			);
		})}
	</div>
));
