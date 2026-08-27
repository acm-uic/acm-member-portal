import { $, component$, useSignal } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, eq } from "drizzle-orm";
import { DynamicField } from "~/components/forms/dynamic-field";
import { ThemeToggle } from "~/components/theme-toggle";
import { db } from "~/lib/db";
import { signupSubmissions, user } from "~/lib/db/schema";
import { loadPublishedSignupForm } from "~/lib/forms/fields";
import {
	clientFieldErrors,
	compileFormSchema,
	flattenFieldErrors,
	postedValues,
	splitAnswers,
	valuesFromFormElement,
} from "~/lib/forms/zod-compiler";

/**
 * PUBLIC route — no session check (FR1/FR2: accounts do not exist until
 * after officer approval). The loader returns only field definitions,
 * which are public by design.
 */
export const useSignupForm = routeLoader$(async () => {
	const form = await loadPublishedSignupForm();
	return { season: form.season, fields: form.fields };
});

export const useSubmitSignup = routeAction$(async (data, event) => {
	const form = await loadPublishedSignupForm();
	const parsed = compileFormSchema(form.fields).safeParse(data);
	if (!parsed.success) {
		return {
			ok: false as const,
			errors: flattenFieldErrors(parsed.error.flatten().fieldErrors),
			values: postedValues(data),
		};
	}

	const { base, answers } = splitAnswers(parsed.data);

	const [pendingNetid] = await db
		.select({ id: signupSubmissions.id })
		.from(signupSubmissions)
		.where(
			and(
				eq(signupSubmissions.netid, base.netid),
				eq(signupSubmissions.status, "pending"),
			),
		)
		.limit(1);
	if (pendingNetid) {
		return {
			ok: false as const,
			errors: { netid: "A signup with this NetID is already pending review." },
			values: postedValues(data),
		};
	}

	const [pendingUsername] = await db
		.select({ id: signupSubmissions.id })
		.from(signupSubmissions)
		.where(
			and(
				eq(signupSubmissions.username, base.username),
				eq(signupSubmissions.status, "pending"),
			),
		)
		.limit(1);
	if (pendingUsername) {
		return {
			ok: false as const,
			errors: {
				username: "A signup with this username is already pending review.",
			},
			values: postedValues(data),
		};
	}

	const [takenUsername] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.username, base.username))
		.limit(1);
	if (takenUsername) {
		return {
			ok: false as const,
			errors: { username: "This username is already in use." },
			values: postedValues(data),
		};
	}

	const preferred = base.preferred_name?.trim() || null;
	await db.insert(signupSubmissions).values({
		schemaVersionId: form.schemaVersionId,
		firstName: base.first_name,
		lastName: base.last_name,
		preferredName: preferred,
		netid: base.netid,
		username: base.username,
		uin: base.uin,
		email: base.email,
		answers,
	});

	throw event.redirect(303, "/signup/confirmation");
});

export default component$(() => {
	const form = useSignupForm();
	const action = useSubmitSignup();
	const clientErrors = useSignal<Record<string, string>>({});

	const onSubmit$ = $(async (event: Event) => {
		const el = event.target as HTMLFormElement;
		const values = valuesFromFormElement(el, form.value.fields);
		const errors = clientFieldErrors(form.value.fields, values);
		clientErrors.value = errors;
		if (Object.keys(errors).length) return;
		await action.submit(new FormData(el));
	});

	const values =
		action.value?.ok === false ? action.value.values : undefined;
	const serverErrors =
		action.value?.ok === false ? action.value.errors : undefined;

	return (
		<main class="min-h-screen grid place-items-center p-xl">
			<div class="absolute top-md right-md">
				<ThemeToggle />
			</div>
			<div class="max-w-lg w-full min-w-0 bg-surface1 border border-border rounded-component shadow-card p-xl grid gap-lg">
				<header class="grid gap-xs">
					<h1 class="font-display text-heading m-0">
						Join <span class="text-accent">ACM</span>@UIC
					</h1>
					<p class="text-text2 text-body m-0">
						{form.value.season
							? `Membership signup for ${form.value.season}. `
							: ""}
						An officer reviews every signup; your ACM account is created after
						approval.
					</p>
				</header>

				<form
					preventdefault:submit
					onSubmit$={onSubmit$}
					class="grid gap-md min-w-0"
					noValidate
				>
					{form.value.fields.map((field) => (
						<DynamicField
							key={field.key}
							field={field}
							value={values?.[field.key]}
							error={serverErrors?.[field.key] ?? clientErrors.value[field.key]}
						/>
					))}
					<button
						type="submit"
						class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
					>
						Submit signup
					</button>
				</form>
			</div>
		</main>
	);
});
