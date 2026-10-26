import { component$, Slot, useId } from "@builder.io/qwik";

export const Panel = component$<{
	title: string;
	meta?: string;
	titleHelp?: string;
}>((props) => {
	const helpId = useId();
	return (
		<article class="p-md border border-border rounded-component bg-surface1 shadow-card">
			<div class="flex items-center justify-between gap-md mb-md">
				<div class="flex items-center gap-sm">
					<h2 class="m-0 text-subheading">{props.title}</h2>
					{props.titleHelp && (
						<span class="relative group">
							<button
								type="button"
								aria-label={`How ${props.title} is counted`}
								aria-describedby={helpId}
								class="flex size-5 items-center justify-center rounded-full border border-text3 bg-transparent p-0 text-caption text-text3 cursor-help hover:text-text1 focus-visible:text-text1"
							>
								?
							</button>
							<span
								id={helpId}
								role="tooltip"
								class="invisible absolute top-full -left-32 z-20 w-64 pt-sm group-hover:visible group-focus-within:visible"
							>
								<span class="block rounded-control border border-border-visible bg-surface2 p-sm text-body-sm text-text1 shadow-overlay">
									{props.titleHelp}
								</span>
							</span>
						</span>
					)}
				</div>
				{props.meta && (
					<span class="text-caption text-text3">{props.meta}</span>
				)}
			</div>
			<Slot />
		</article>
	);
});
