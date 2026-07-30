import { component$, Slot } from "@builder.io/qwik";

export const Panel = component$<{ title: string; meta?: string }>((props) => (
	<article class="p-md border border-border rounded-component bg-surface1 shadow-card">
		<div class="flex items-center justify-between gap-md mb-md">
			<h2 class="m-0 text-subheading">{props.title}</h2>
			{props.meta && <span class="text-caption text-text3">{props.meta}</span>}
		</div>
		<Slot />
	</article>
));
