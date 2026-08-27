import { component$ } from "@builder.io/qwik";
import { Form, routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, eq } from "drizzle-orm";
import { DynamicField } from "~/components/forms/dynamic-field";
import { db } from "~/lib/db";
import { signupSubmissions } from "~/lib/db/schema";
import { loadPublishedSignupForm } from "~/lib/forms/fields";
import { compileFormSchema, splitAnswers } from "~/lib/forms/zod-compiler";
import { ThemeToggle } from "~/components/theme-toggle";

/**
 * PUBLIC route — no session check (FR1/FR2: accounts do not exist until
 * after officer approval). The loader returns only field definitions,
 * which are public by design.
 */
export const useSignupForm = routeLoader$(async () => {
	const form = await loadPublishedSignupForm();
	return { season: form.season, fields: form.fields };
});

function fieldErrors(
	flat: Record<string, string[] | undefined>,
): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const [key, msgs] of Object.entries(flat)) {
		if (msgs?.length) errors[key] = msgs[0]!;
	}
	return errors;
}

/** Keep posted strings/arrays so the form can rehydrate after a validation error. */
function postedValues(
	data: Record<string, unknown>,
): Record<string, string | string[]> {
	const values: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === "string") values[key] = value;
		else if (Array.isArray(value)) values[key] = value.map(String);
		else if (typeof value === "number" || typeof value === "boolean")
			values[key] = String(value);
	}
	return values;
}

export const useSubmitSignup = routeAction$(async (data, event) => {
	const form = await loadPublishedSignupForm();
	const parsed = compileFormSchema(form.fields).safeParse(data);
	if (!parsed.success) {
		return {
			ok: false as const,
			errors: fieldErrors(parsed.error.flatten().fieldErrors),
			values: postedValues(data),
		};
	}

	const { base, answers } = splitAnswers(parsed.data);

	const [pendingDupe] = await db
		.select({ id: signupSubmissions.id })
		.from(signupSubmissions)
		.where(
			and(
				eq(signupSubmissions.netid, base.netid),
				eq(signupSubmissions.status, "pending"),
			),
		)
		.limit(1);
	if (pendingDupe) {
		return {
			ok: false as const,
			errors: { netid: "A signup with this NetID is already pending review." },
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
		uin: base.uin,
		email: base.email,
		answers,
	});

	throw event.redirect(303, "/signup/confirmation");
});

export default component$(() => {
	const form = useSignupForm();
	const action = useSubmitSignup();

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

				<Form action={action} class="grid gap-md min-w-0">
					{form.value.fields.map((field) => (
						<DynamicField
							key={field.key}
							field={field}
							value={
								action.value?.ok === false
									? action.value.values[field.key]
									: undefined
							}
							error={
								action.value?.ok === false
									? action.value.errors[field.key]
									: undefined
							}
						/>
					))}
					<button
						type="submit"
						class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
					>
						Submit signup
					</button>
				</Form>
			</div>
		</main>
	);
});
