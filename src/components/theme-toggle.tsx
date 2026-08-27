import { $, component$, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import type { ThemeMode } from "~/lib/types";

export const ThemeToggle = component$<{ class?: string }>((props) => {
	const theme = useSignal<ThemeMode>("dark");

	useVisibleTask$(() => {
		theme.value =
			document.documentElement.dataset.theme === "light" ? "light" : "dark";
	});

	const toggle = $(() => {
		const next: ThemeMode = theme.value === "dark" ? "light" : "dark";
		theme.value = next;
		document.documentElement.dataset.theme = next;
		try {
			localStorage.setItem("acm-theme", next);
		} catch {
			/* private mode — theme resets next visit */
		}
	});

	return (
		<button
			type="button"
			aria-label="Toggle color theme"
			onClick$={toggle}
			class={`h-8 px-md rounded-pill bg-surface3 text-text3 hover:text-text1 transition-colors duration-fast ease-standard text-label whitespace-nowrap inline-flex items-center justify-center ${props.class ?? ""}`}
		>
			{theme.value === "dark" ? "☾ Dark" : "☀ Light"}
		</button>
	);
});
