import { component$ } from "@builder.io/qwik";
import { Link } from "@builder.io/qwik-city";

export default component$(() => {
	return (
		<main class="min-h-screen grid place-items-center p-xl">
			<div class="max-w-md w-full min-w-0 bg-surface1 border border-border rounded-component shadow-card p-xl grid gap-md">
				<p class="m-0 inline-flex w-fit px-sm py-2xs rounded-element bg-success-bg text-success text-label">
					Signup received
				</p>
				<h1 class="font-display text-heading m-0">Pending review</h1>
				<p class="text-text2 text-body m-0">
					An officer will review your signup. Once approved, your ACM Microsoft
					account is created and your sign-in details are emailed to your
					personal address.
				</p>
				<Link href="/" class="text-accent text-label no-underline">
					Back to home
				</Link>
			</div>
		</main>
	);
});
