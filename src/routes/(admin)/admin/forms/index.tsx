import { component$ } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { FieldEditor } from "~/components/admin/field-editor";
import { db } from "~/lib/db";
import { auditEvents, formSchemas } from "~/lib/db/schema";
import { requirePermission } from "~/lib/rbac/guards";
import type { FormFieldDef } from "~/lib/types";

const optionSchema = z.object({
	value: z.string().min(1),
	label: z.string().min(1),
});
const fieldDefSchema = z.object({
	key: z.string().regex(/^[a-z][a-z0-9_]*$/, "lowercase_snake_case keys only"),
	label: z.string().min(1),
	type: z.enum([
		"text",
		"email",
		"number",
		"select",
		"multiselect",
		"checkbox",
		"textarea",
	]),
	required: z.boolean(),
	order: z.number().int(),
	options: z.array(optionSchema).optional(),
	placeholder: z.string().optional(),
	helpText: z.string().optional(),
	min: z.number().optional(),
	max: z.number().optional(),
	minLength: z.number().int().positive().optional(),
	maxLength: z.number().int().positive().optional(),
});
const fieldsPayloadSchema = z.object({ fields: z.array(fieldDefSchema) });

export const useFormSchemas = routeLoader$(async (event) => {
	await requirePermission(event, "forms.read");
	const rows = await db
		.select()
		.from(formSchemas)
		.where(eq(formSchemas.formKey, "signup"))
		.orderBy(desc(formSchemas.version));
	return rows.map((r) => ({
		id: r.id,
		version: r.version,
		status: r.status,
		season: r.season,
		fields: (r.fields as { fields: FormFieldDef[] }).fields,
		publishedAt: r.publishedAt,
	}));
});

export const useSaveDraft = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "forms.manage");
	const season = String(data.season ?? "").slice(0, 32) || null;

	let rawFields: unknown;
	try {
		rawFields = JSON.parse(String(data.fields ?? "[]"));
	} catch {
		return { ok: false as const, error: "Invalid fields payload." };
	}
	const parsed = fieldsPayloadSchema.safeParse({ fields: rawFields });
	if (!parsed.success) {
		return {
			ok: false as const,
			error: "Invalid field definitions — check keys, types, and options.",
		};
	}

	await db.transaction(async (tx) => {
		const [latest] = await tx
			.select({ version: formSchemas.version })
			.from(formSchemas)
			.where(eq(formSchemas.formKey, "signup"))
			.orderBy(desc(formSchemas.version))
			.limit(1);
		const nextVersion = (latest?.version ?? 0) + 1;

		await tx.insert(formSchemas).values({
			formKey: "signup",
			version: nextVersion,
			status: "draft",
			season,
			fields: parsed.data,
			createdBy: session.user.id,
		});
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: "forms.draft",
			targetType: "form_schema",
			targetId: `signup:v${nextVersion}`,
			after: { season, fieldCount: parsed.data.fields.length },
		});
	});

	return { ok: true as const };
});

export const usePublishSchema = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "forms.manage");
	const id = String(data.id ?? "");

	const published = await db.transaction(async (tx) => {
		const [draft] = await tx
			.select()
			.from(formSchemas)
			.where(and(eq(formSchemas.id, id), eq(formSchemas.status, "draft")))
			.limit(1);
		if (!draft) return null;

		await tx
			.update(formSchemas)
			.set({ status: "archived" })
			.where(
				and(
					eq(formSchemas.formKey, "signup"),
					eq(formSchemas.status, "published"),
				),
			);
		await tx
			.update(formSchemas)
			.set({ status: "published", publishedAt: new Date() })
			.where(eq(formSchemas.id, id));
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: "forms.publish",
			targetType: "form_schema",
			targetId: `signup:v${draft.version}`,
		});
		return draft;
	});

	if (!published)
		return {
			ok: false as const,
			error: "Draft not found (already published?).",
		};
	return { ok: true as const };
});

export default component$(() => {
	const schemas = useFormSchemas();
	const saveDraft = useSaveDraft();
	const publish = usePublishSchema();
	const latest = schemas.value[0];

	return (
		<main class="p-xl grid gap-lg max-w-4xl">
			<header>
				<h1 class="font-display text-heading m-0">Signup form</h1>
				<p class="text-text2 text-body m-0">
					Edit the dynamic fields, save as a new draft version, then publish.
					Publishing archives the current version; past submissions keep their
					original schema.
				</p>
			</header>

			{saveDraft.value?.ok === false && (
				<p role="alert" class="text-error text-label m-0">
					{saveDraft.value.error}
				</p>
			)}

			<section class="grid gap-sm">
				<h2 class="text-subheading m-0">Versions</h2>
				{schemas.value.map((s) => (
					<div
						key={s.id}
						class="flex items-center justify-between gap-md bg-surface1 border border-border rounded-component p-md"
					>
						<div class="text-body-sm">
							<span class="font-mono text-text1">v{s.version}</span>
							<span
								class={`ml-sm px-sm py-2xs rounded-element text-caption font-semibold ${
									s.status === "published"
										? "bg-success-bg text-success"
										: s.status === "draft"
											? "bg-warning-bg text-warning"
											: "bg-surface3 text-text3"
								}`}
							>
								{s.status}
							</span>
							{s.season && <span class="ml-sm text-text3">{s.season}</span>}
							<span class="ml-sm text-caption text-text3">
								{s.fields.length} fields
							</span>
						</div>
						{s.status === "draft" && (
							<button
								type="button"
								class="px-sm py-2xs rounded-control bg-accent text-white text-label cursor-pointer"
								onClick$={async () => {
									await publish.submit({ id: s.id });
								}}
							>
								Publish
							</button>
						)}
					</div>
				))}
			</section>

			<section class="grid gap-md">
				<h2 class="text-subheading m-0">
					New draft {latest ? `(starting from v${latest.version})` : ""}
				</h2>
				<form
					preventdefault:submit
					onSubmit$={async (e) => {
						const form = e.target as HTMLFormElement;
						await saveDraft.submit(new FormData(form));
					}}
					class="grid gap-md"
				>
					<div class="grid gap-xs max-w-xs">
						<label for="season" class="text-label text-text2">
							Season label
						</label>
						<input
							id="season"
							name="season"
							type="text"
							placeholder="2026-2027"
							value={latest?.season ?? ""}
							class="px-sm py-sm rounded-control bg-surface3 text-text1 border border-border"
						/>
					</div>
					<FieldEditor initialFields={latest?.fields ?? []} />
					<button
						type="submit"
						class="w-fit px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
					>
						Save as new draft
					</button>
				</form>
			</section>
		</main>
	);
});
