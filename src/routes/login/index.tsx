import { $, component$ } from "@builder.io/qwik";
import {
	Form,
	routeAction$,
	routeLoader$,
	useLocation,
	z,
	zod$,
} from "@builder.io/qwik-city";
import { ThemeToggle } from "~/components/theme-toggle";
import { auth, microsoftConfigured } from "~/lib/auth";
import { isDevLoginEnabled } from "~/lib/db/mode";

export const useLoginOptions = routeLoader$(() => ({
	devLogin: isDevLoginEnabled(),
	microsoft: microsoftConfigured,
}));

export const useDevLogin = routeAction$(
	async (data, event) => {
		if (!isDevLoginEnabled()) {
			return { ok: false as const, error: "Dev login is disabled." };
		}
		const next = String(data.next || "/dashboard");
		try {
			const res = await auth.api.signInEmail({
				body: {
					email: data.email,
					password: data.password,
				},
				headers: event.request.headers,
				asResponse: true,
			});

			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as {
					message?: string;
				} | null;
				return {
					ok: false as const,
					error: body?.message ?? "Invalid email or password.",
				};
			}

			const setCookie = res.headers.getSetCookie?.() ?? [];
			for (const cookie of setCookie) {
				event.headers.append("set-cookie", cookie);
			}
			// Fallback for runtimes without getSetCookie
			if (setCookie.length === 0) {
				const single = res.headers.get("set-cookie");
				if (single) event.headers.append("set-cookie", single);
			}

			throw event.redirect(303, next.startsWith("/") ? next : "/dashboard");
		} catch (err) {
			if (err && typeof err === "object" && "status" in err) throw err;
			return {
				ok: false as const,
				error: err instanceof Error ? err.message : "Sign-in failed.",
			};
		}
	},
	zod$({
		email: z.string().email(),
		password: z.string().min(1),
		next: z.string().optional(),
	}),
);

export default component$(() => {
	const loc = useLocation();
	const options = useLoginOptions();
	const action = useDevLogin();
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

				{options.value.devLogin ? (
					<>
						<p class="text-text2 text-body m-0">
							Local development login. Seeded officer:{" "}
							<code class="text-label">officer@local.test</code> /{" "}
							<code class="text-label">local-dev</code>. Not Entra or real AD.
						</p>
						<Form action={action} class="grid gap-md">
							<input type="hidden" name="next" value={next} />
							<label class="grid gap-xs">
								<span class="text-label text-text2">Email</span>
								<input
									type="email"
									name="email"
									required
									defaultValue="officer@local.test"
									class="px-md py-sm rounded-control bg-surface2 border border-border text-body"
								/>
							</label>
							<label class="grid gap-xs">
								<span class="text-label text-text2">Password</span>
								<input
									type="password"
									name="password"
									required
									defaultValue="local-dev"
									class="px-md py-sm rounded-control bg-surface2 border border-border text-body"
								/>
							</label>
							{action.value?.ok === false ? (
								<p class="text-danger text-label m-0">{action.value.error}</p>
							) : null}
							<button
								type="submit"
								class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
							>
								Sign in
							</button>
						</Form>
					</>
				) : (
					<p class="text-text2 text-body m-0">
						Log in with your ACM Microsoft account. New here? Accounts are
						created after your signup is approved.
					</p>
				)}

				{options.value.microsoft ? (
					<button
						type="button"
						onClick$={login}
						class="px-md py-sm rounded-control bg-transparent text-text1 border border-border-visible text-label cursor-pointer"
					>
						Sign in with Microsoft
					</button>
				) : null}
			</div>
		</main>
	);
});
