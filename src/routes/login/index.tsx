import { $, component$ } from "@builder.io/qwik";
import { useLocation } from "@builder.io/qwik-city";
import { ThemeToggle } from "~/components/theme-toggle";

export default component$(() => {
	const loc = useLocation();
	const next = loc.url.searchParams.get("next") ?? "/dashboard";

	const login = $(async () => {
		const res = await fetch("/api/auth/sign-in/social", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "microsoft", callbackURL: next }),
		});
		const data = (await res.json()) as { url?: string };
		if (data.url) window.location.href = data.url;
	});

	return (
		<main class="min-h-screen grid place-items-center p-xl">
			<div class="absolute top-md right-md">
				<ThemeToggle />
			</div>
			<div class="max-w-md w-full bg-surface1 border border-border rounded-component shadow-card p-xl grid gap-md">
				<h1 class="font-display text-heading m-0">
					<span class="text-accent">ACM</span>@UIC
				</h1>
				<p class="text-text2 text-body m-0">
					Log in with your ACM Microsoft account. New here? Accounts are created
					after your signup is approved.
				</p>
				<button
					type="button"
					onClick$={login}
					class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
				>
					Sign in with Microsoft
				</button>
			</div>
		</main>
	);
});
