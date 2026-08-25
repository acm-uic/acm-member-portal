import { component$ } from "@builder.io/qwik";
import { Link } from "@builder.io/qwik-city";
import { ThemeToggle } from "~/components/theme-toggle";

export default component$(() => {
	return (
		<main class="min-h-screen grid place-items-center p-xl">
			<div class="absolute top-md right-md">
				<ThemeToggle />
			</div>
			<div class="max-w-md w-full min-w-0 bg-surface1 border border-border rounded-component shadow-card p-xl grid gap-md">
				<h1 class="font-display text-heading m-0">
					<span class="text-accent">ACM</span>@UIC
				</h1>
				<p class="text-text2 text-body m-0">
					Member portal — sign up, or log in with your ACM Microsoft account.
				</p>
				<div class="flex gap-sm">
					<Link
						href="/signup"
						class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label no-underline"
					>
						Sign up
					</Link>
					<Link
						href="/login"
						class="px-md py-sm rounded-control bg-transparent text-text1 border border-border-visible text-label no-underline"
					>
						Log in
					</Link>
				</div>
			</div>
		</main>
	);
});
