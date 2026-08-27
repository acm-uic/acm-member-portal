import { $, component$, useSignal } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { eq } from "drizzle-orm";
import { DynamicField } from "~/components/forms/dynamic-field";
import { db } from "~/lib/db";
import { auditEvents, memberProfiles, user } from "~/lib/db/schema";
import {
	formatSignupDisplayName,
	loadPublishedSignupForm,
} from "~/lib/forms/fields";
import {
	changedFields,
	clientFieldErrors,
	compileFormSchema,
	flattenFieldErrors,
	profileSnapshot,
	splitAnswers,
	valuesFromFormElement,
} from "~/lib/forms/zod-compiler";
import { syncAdUser } from "~/lib/provisioning/ad-sync";
import type { PortalSession } from "~/lib/types";

function identityValues(row: {
	firstName: string | null;
	lastName: string | null;
	preferredName: string | null;
	netid: string | null;
	username: string | null;
	uin: string | null;
	email: string;
	name: string;
}): Record<string, string> {
	let first = row.firstName ?? "";
	let last = row.lastName ?? "";
	if (!first && row.name) {
		const parts = row.name.trim().split(/\s+/);
		first = parts[0] ?? "";
		last = parts.slice(1).join(" ");
	}
	return {
		first_name: first,
		last_name: last,
		preferred_name: row.preferredName ?? "",
		netid: row.netid ?? "",
		username: row.username ?? row.netid ?? "",
		uin: row.uin ?? "",
		email: row.email,
	};
}

export const useProfileForm = routeLoader$(async ({ sharedMap }) => {
	const session = sharedMap.get("session") as PortalSession;
	const [form, [profile], [row]] = await Promise.all([
		loadPublishedSignupForm(),
		db
			.select({
				answers: memberProfiles.answers,
			})
			.from(memberProfiles)
			.where(eq(memberProfiles.userId, session.user.id))
			.limit(1),
		db.select().from(user).where(eq(user.id, session.user.id)).limit(1),
	]);

	return {
		season: form.season,
		fields: form.fields,
		answers: {
			...((profile?.answers ?? {}) as Record<string, unknown>),
			...identityValues(
				row ?? {
					firstName: null,
					lastName: null,
					preferredName: null,
					netid: session.user.netid,
					username: session.user.username,
					uin: null,
					email: session.user.email,
					name: session.user.name,
				},
			),
		},
	};
});

export const useSaveProfile = routeAction$(async (data, { sharedMap }) => {
	const session = sharedMap.get("session") as PortalSession;
	const form = await loadPublishedSignupForm();

	const parsed = compileFormSchema(form.fields).safeParse(data);
	if (!parsed.success) {
		return {
			ok: false as const,
			errors: flattenFieldErrors(parsed.error.flatten().fieldErrors),
		};
	}

	const { base, answers } = splitAnswers(parsed.data);
	const preferred = base.preferred_name?.trim() || null;
	const displayName = formatSignupDisplayName({
		firstName: base.first_name,
		lastName: base.last_name,
		preferredName: preferred,
	});

	const [current] = await db
		.select()
		.from(user)
		.where(eq(user.id, session.user.id))
		.limit(1);
	if (!current) {
		return { ok: false as const, errors: { email: "Account was not found." } };
	}

	const [profile] = await db
		.select({
			answers: memberProfiles.answers,
		})
		.from(memberProfiles)
		.where(eq(memberProfiles.userId, session.user.id))
		.limit(1);

	const [emailTaken] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, base.email))
		.limit(1);
	if (emailTaken && emailTaken.id !== session.user.id) {
		return {
			ok: false as const,
			errors: { email: "This email is already in use." },
		};
	}

	const [netidTaken] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.netid, base.netid))
		.limit(1);
	if (netidTaken && netidTaken.id !== session.user.id) {
		return {
			ok: false as const,
			errors: { netid: "This NetID is already in use." },
		};
	}

	const [usernameTaken] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.username, base.username))
		.limit(1);
	if (usernameTaken && usernameTaken.id !== session.user.id) {
		return {
			ok: false as const,
			errors: { username: "This username is already in use." },
		};
	}

	const before = profileSnapshot({
		...identityValues(current),
		...((profile?.answers ?? {}) as Record<string, unknown>),
	});
	const after = profileSnapshot({
		first_name: base.first_name,
		last_name: base.last_name,
		preferred_name: preferred ?? "",
		netid: base.netid,
		username: base.username,
		uin: base.uin,
		email: base.email,
		...answers,
	});
	const changes = changedFields(before, after);

	await db.transaction(async (tx) => {
		await tx
			.update(user)
			.set({
				name: displayName,
				email: base.email,
				netid: base.netid,
				username: base.username,
				uin: base.uin,
				firstName: base.first_name,
				lastName: base.last_name,
				preferredName: preferred,
				displayName,
				updatedAt: new Date(),
			})
			.where(eq(user.id, session.user.id));
		await tx
			.update(memberProfiles)
			.set({
				answers,
				answersSchemaVersionId: form.schemaVersionId,
			})
			.where(eq(memberProfiles.userId, session.user.id));
		if (changes.length) {
			await tx.insert(auditEvents).values({
				actorId: session.user.id,
				action: "profile.update",
				targetType: "user",
				targetId: session.user.id,
				before,
				after: { ...after, changes },
			});
		}
	});

	let adWarning: string | undefined;
	if (changes.length) {
		const previousSam = current.username || current.netid;
		if (previousSam) {
			const ad = await syncAdUser({
				samAccountName: previousSam,
				username: base.username,
				firstName: base.first_name,
				lastName: base.last_name,
				preferredName: preferred ?? undefined,
				displayName,
				email: base.email,
				uin: base.uin,
			});
			if (!ad.ok) adWarning = ad.error;
		}
	}

	return { ok: true as const, adWarning };
});

export default component$(() => {
	const profile = useProfileForm();
	const save = useSaveProfile();
	const clientErrors = useSignal<Record<string, string>>({});

	const onSubmit$ = $(async (event: Event) => {
		const el = event.target as HTMLFormElement;
		const values = valuesFromFormElement(el, profile.value.fields);
		const errors = clientFieldErrors(profile.value.fields, values);
		clientErrors.value = errors;
		if (Object.keys(errors).length) return;
		await save.submit(new FormData(el));
	});

	const serverErrors = save.value?.ok === false ? save.value.errors : undefined;

	return (
		<main class="p-xl grid gap-lg max-w-2xl">
			<header>
				<h1 class="font-display text-heading m-0">Your profile</h1>
				<p class="text-text2 text-body m-0">
					These are the same fields you filled in at signup. You can update
					them here
					{profile.value.season
						? `, including anything collected for ${profile.value.season}`
						: ""}
					.
				</p>
			</header>

			<form
				preventdefault:submit
				onSubmit$={onSubmit$}
				class="grid gap-md"
				noValidate
			>
				{profile.value.fields.map((field) => {
					const raw = profile.value.answers[field.key];
					const value = (
						Array.isArray(raw) ? raw : String(raw ?? "")
					) as string | string[];
					return (
						<DynamicField
							key={field.key}
							field={field}
							value={value}
							error={
								serverErrors?.[field.key] ?? clientErrors.value[field.key]
							}
						/>
					);
				})}
				<div class="flex items-center gap-md flex-wrap">
					<button
						type="submit"
						class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
					>
						Save changes
					</button>
					{save.value?.ok && (
						<span class="text-success text-label">Saved.</span>
					)}
					{save.value?.ok && save.value.adWarning && (
						<span class="text-warning text-label">
							Saved here, but Active Directory was not updated.{" "}
							{save.value.adWarning}
						</span>
					)}
				</div>
			</form>
		</main>
	);
});
