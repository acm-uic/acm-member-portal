import { component$ } from "@builder.io/qwik";
import { Form, routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { eq } from "drizzle-orm";
import { DynamicField } from "~/components/forms/dynamic-field";
import { db } from "~/lib/db";
import { auditEvents, memberProfiles } from "~/lib/db/schema";
import { BASE_FIELD_KEYS, loadPublishedSignupForm } from "~/lib/forms/fields";
import { compileFormSchema } from "~/lib/forms/zod-compiler";
import type { PortalSession } from "~/lib/types";

/** Current dynamic schema + the member's existing answers (FR10). */
export const useProfileForm = routeLoader$(async ({ sharedMap }) => {
	const session = sharedMap.get("session") as PortalSession;
	const [form, [profile]] = await Promise.all([
		loadPublishedSignupForm(),
		db
			.select({ answers: memberProfiles.answers })
			.from(memberProfiles)
			.where(eq(memberProfiles.userId, session.user.id))
			.limit(1),
	]);
	const dynamicFields = form.fields.filter(
		(f) => !(BASE_FIELD_KEYS as readonly string[]).includes(f.key),
	);
	return {
		season: form.season,
		fields: dynamicFields,
		answers: (profile?.answers ?? {}) as Record<string, unknown>,
		identity: {
			name: session.user.name,
			netid: session.user.netid,
			email: session.user.email,
		},
	};
});

export const useSaveProfile = routeAction$(async (data, { sharedMap }) => {
	const session = sharedMap.get("session") as PortalSession;
	const form = await loadPublishedSignupForm();
	const dynamicFields = form.fields.filter(
		(f) => !(BASE_FIELD_KEYS as readonly string[]).includes(f.key),
	);

	const parsed = compileFormSchema(dynamicFields).safeParse(data);
	if (!parsed.success) {
		const flat = parsed.error.flatten().fieldErrors;
		const errors: Record<string, string> = {};
		for (const [key, msgs] of Object.entries(flat)) {
			if (msgs?.length) errors[key] = msgs[0];
		}
		return { ok: false as const, errors };
	}

	await db.transaction(async (tx) => {
		await tx
			.update(memberProfiles)
			.set({
				answers: parsed.data,
				answersSchemaVersionId: form.schemaVersionId,
			})
			.where(eq(memberProfiles.userId, session.user.id));
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: "profile.update",
			targetType: "member_profile",
			targetId: session.user.id,
			after: parsed.data,
		});
	});

	return { ok: true as const };
});

export default component$(() => {
	const profile = useProfileForm();
	const save = useSaveProfile();

	return (
		<main class="p-xl grid gap-lg max-w-2xl">
			<header>
				<h1 class="font-display text-heading m-0">Your profile</h1>
				<p class="text-text2 text-body m-0">
					Identity fields come from your ACM account. Everything else is yours
					to edit
					{profile.value.season
						? ` — collected for ${profile.value.season}`
						: ""}
					.
				</p>
			</header>

			<section class="bg-surface1 border border-border rounded-component p-md grid gap-xs">
				<div class="text-body-sm">
					<span class="text-text3">Name: </span>
					<span class="text-text1">{profile.value.identity.name}</span>
				</div>
				<div class="text-body-sm">
					<span class="text-text3">NetID: </span>
					<span class="font-mono text-text1">
						{profile.value.identity.netid ?? "—"}
					</span>
				</div>
				<div class="text-body-sm">
					<span class="text-text3">Email: </span>
					<span class="text-text1">{profile.value.identity.email}</span>
				</div>
			</section>

			<Form action={save} class="grid gap-md">
				{profile.value.fields.map((field) => (
					<DynamicField
						key={field.key}
						field={field}
						value={
							(Array.isArray(profile.value.answers[field.key])
								? profile.value.answers[field.key]
								: String(profile.value.answers[field.key] ?? "")) as
								| string
								| string[]
						}
						error={
							save.value?.ok === false
								? save.value.errors[field.key]
								: undefined
						}
					/>
				))}
				<div class="flex items-center gap-md">
					<button
						type="submit"
						class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
					>
						Save changes
					</button>
					{save.value?.ok && (
						<span class="text-success text-label">Saved.</span>
					)}
				</div>
			</Form>
		</main>
	);
});
