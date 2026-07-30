import { component$ } from "@builder.io/qwik";

/** CSS bar chart (archetype `.chart`): accent-tinted bars, 2px accent top. */
export const ParticipationChart = component$<{
	bars: number[];
	startLabel: string;
	endLabel: string;
}>((props) => {
	const max = Math.max(...props.bars, 1);
	return (
		<div class="relative h-[170px] flex items-end gap-2xs pt-md pb-lg border-b border-border">
			{props.bars.map((value, i) => (
				<div
					key={i}
					class="flex-1 min-w-[5px] rounded-t-element bg-accent-subtle border-t-2 border-accent"
					style={{ height: `${Math.max(Math.round((value / max) * 100), 2)}%` }}
				/>
			))}
			<span class="absolute bottom-0 left-0 text-caption text-text4">
				{props.startLabel}
			</span>
			<span class="absolute bottom-0 right-0 text-caption text-text4">
				{props.endLabel}
			</span>
		</div>
	);
});
