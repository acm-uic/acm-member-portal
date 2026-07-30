import { component$ } from "@builder.io/qwik";

const TONE_CLASS = {
	success: "text-success",
	warning: "text-warning",
	error: "text-error",
} as const;

export type MetricTone = keyof typeof TONE_CLASS;

export const MetricCard = component$<{
	label: string;
	value: string;
	note?: string;
	tone?: MetricTone;
}>((props) => (
	<article class="p-md border border-border rounded-component bg-surface1 shadow-card">
		<span class="text-caption text-text2">{props.label}</span>
		<div class="mt-sm font-display text-[28px] font-bold leading-tight">
			{props.value}
		</div>
		{props.note && (
			<div
				class={`text-caption ${props.tone ? TONE_CLASS[props.tone] : "text-text3"}`}
			>
				{props.note}
			</div>
		)}
	</article>
));
