import { and, desc, eq } from "drizzle-orm";
import type { FormFieldDef, FormSchemaDefinition } from "~/lib/types";

/**
 * Base fields are LOCKED (FR1): they map to first-class columns on
 * signup_submissions and are not admin-removable. Negative orders keep
 * them ahead of admin-defined fields (orders 1..n).
 */
export const BASE_FIELD_KEYS = [
	"display_name",
	"netid",
	"uin",
	"email",
] as const;
export type BaseFieldKey = (typeof BASE_FIELD_KEYS)[number];

export const BASE_FIELDS: FormFieldDef[] = [
	{
		key: "display_name",
		label: "Full name",
		type: "text",
		required: true,
		order: -4,
		maxLength: 120,
	},
	{
		key: "netid",
		label: "NetID",
		type: "text",
		required: true,
		order: -3,
		maxLength: 32,
	},
	{
		key: "uin",
		label: "UIN",
		type: "text",
		required: true,
		order: -2,
		maxLength: 9,
	},
	{
		key: "email",
		label: "Personal email",
		type: "email",
		required: true,
		order: -1,
		maxLength: 254,
	},
];

export interface PublishedForm {
	schemaVersionId: string;
	season: string | null;
	/** Base + dynamic fields, sorted by order. */
	fields: FormFieldDef[];
}

/** Latest published signup form — the shape the public route renders. */
export async function loadPublishedSignupForm(): Promise<PublishedForm> {
	const { db } = await import("~/lib/db");
	const { formSchemas } = await import("~/lib/db/schema");

	const [row] = await db
		.select()
		.from(formSchemas)
		.where(
			and(
				eq(formSchemas.formKey, "signup"),
				eq(formSchemas.status, "published"),
			),
		)
		.orderBy(desc(formSchemas.version))
		.limit(1);

	if (!row) throw new Error("No published signup form schema");

	const definition = row.fields as FormSchemaDefinition;
	const fields = [...BASE_FIELDS, ...definition.fields].sort(
		(a, b) => a.order - b.order,
	);
	return { schemaVersionId: row.id, season: row.season, fields };
}
