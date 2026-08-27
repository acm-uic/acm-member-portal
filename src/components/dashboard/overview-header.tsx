import { component$ } from "@builder.io/qwik";

export const OverviewHeader = component$<{
	displayName: string;
	subtitle: string;
	previewLabel?: string | null;
}>((props) => (
	<header class="mb-sm">
		<p class="m-0 text-accent text-caption font-semibold uppercase tracking-wider">
			{new Date().toLocaleDateString("en-US", {
				weekday: "long",
				month: "long",
				day: "numeric",
			})}
		</p>
		<h1 class="m-0 mt-2xs font-display text-heading">
			Hello, {props.displayName.split(" ")[0]}.
		</h1>
		<p class="m-0 mt-2xs text-text2 text-body-sm">{props.subtitle}</p>
		{props.previewLabel ? (
			<p class="m-0 mt-sm text-caption text-warning">
				Previewing {props.previewLabel} overview — your permissions are unchanged.
			</p>
		) : null}
	</header>
));
