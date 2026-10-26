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
			{props.bars.map((value, i) => {
				const weeksAgo = props.bars.length - 1 - i;
				const period =
					weeksAgo === 0
						? "Last 7 days"
						: `${weeksAgo * 7}\u2013${(weeksAgo + 1) * 7} days ago`;
				const count = `${value} new ${value === 1 ? "member" : "members"}`;
				const position =
					i < 4
						? "left-0"
						: i >= props.bars.length - 4
							? "right-0"
							: "left-1/2 -translate-x-1/2";
				return (
					<button
						key={i}
						type="button"
						aria-label={`${period}: ${count}`}
						class="relative group flex h-full flex-1 min-w-[5px] items-end border-0 bg-transparent p-0 cursor-help"
					>
						<span
							class="relative block w-full rounded-t-element bg-accent-subtle border-t-2 border-accent"
							style={{
								height: `${Math.max(Math.round((value / max) * 100), 2)}%`,
							}}
						>
							<span
								aria-hidden="true"
								class={`pointer-events-none invisible absolute bottom-full z-10 mb-xs whitespace-nowrap rounded-control border border-border-visible bg-surface2 px-sm py-xs text-caption text-text1 shadow-overlay group-hover:visible group-focus-visible:visible ${position}`}
							>
								<span class="block">{period}</span>
								<span class="block font-semibold">{count}</span>
							</span>
						</span>
					</button>
				);
			})}
			<span class="absolute bottom-0 left-0 text-caption text-text4">
				{props.startLabel}
			</span>
			<span class="absolute bottom-0 right-0 text-caption text-text4">
				{props.endLabel}
			</span>
		</div>
	);
});
