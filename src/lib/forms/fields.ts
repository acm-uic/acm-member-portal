import { and, desc, eq } from "drizzle-orm";
import type { FormFieldDef, FormSchemaDefinition } from "~/lib/types";

/**
 * Base fields are LOCKED (FR1): they map to first-class columns on
 * signup_submissions and are not admin-removable. Negative orders keep
 * them ahead of admin-defined fields (orders 1..n).
 */
export const BASE_FIELD_KEYS = [
	"first_name",
	"last_name",
	"preferred_name",
	"netid",
	"username",
	"uin",
	"email",
] as const;
export type BaseFieldKey = (typeof BASE_FIELD_KEYS)[number];

export const USERNAME_MAX_LENGTH = 64;
/** Allows empty so the required check can fire first; non-empty must be alphanumeric. */
export const USERNAME_PATTERN = /^[a-zA-Z0-9]*$/;

export const BASE_FIELDS: FormFieldDef[] = [
	{
		key: "first_name",
		label: "First name",
		type: "text",
		required: true,
		order: -7,
		maxLength: 60,
	},
	{
		key: "last_name",
		label: "Last name",
		type: "text",
		required: true,
		order: -6,
		maxLength: 60,
	},
	{
		key: "preferred_name",
		label: "Preferred name",
		type: "text",
		required: false,
		order: -5,
		maxLength: 60,
		helpText: "What should we call you? Leave blank to use your first name.",
	},
	{
		key: "netid",
		label: "NetID",
		type: "text",
		required: true,
		order: -4,
		maxLength: 32,
	},
	{
		key: "username",
		label: "Username",
		type: "text",
		required: true,
		order: -3,
		maxLength: USERNAME_MAX_LENGTH,
		helpText:
			"Letters and numbers only, up to 64 characters. This becomes your ACM account name.",
	},
	{
		key: "uin",
		label: "UIN",
		type: "text",
		required: true,
		order: -2,
		minLength: 9,
		maxLength: 9,
		helpText: "9-digit University Identification Number. Leading zeros are fine.",
	},
	{
		key: "email",
		label: "Personal email",
		type: "email",
		required: true,
		order: -1,
		maxLength: 254,
		helpText: "Use a personal address, not a UIC / UIUC / Illinois email.",
	},
];


/**
 * AD `Company` values for each college option. Short names match how
 * officers create accounts by hand (e.g. Company "Engineering").
 */
export const COLLEGE_COMPANY: Record<string, string> = {
	applied_health_sciences: "Applied Health Sciences",
	architecture_design_arts: "Architecture, Design, and the Arts",
	business_administration: "Business Administration",
	education: "Education",
	engineering: "Engineering",
	honors: "Honors",
	liberal_arts_sciences: "Liberal Arts and Sciences",
	nursing: "Nursing",
	pharmacy: "Pharmacy",
	public_health: "Public Health",
	urban_planning_public_affairs: "Urban Planning and Public Affairs",
	teacher_education: "Teacher Education",
	other: "Other",
};

export function companyForCollege(college: string | null | undefined): string | undefined {
	if (!college) return undefined;
	return COLLEGE_COMPANY[college] ?? college;
}

/** Preferred name if set, otherwise "First Last". */
export function formatSignupDisplayName(parts: {
	firstName: string;
	lastName: string;
	preferredName?: string | null;
}): string {
	const preferred = parts.preferredName?.trim();
	if (preferred) return preferred;
	return `${parts.firstName} ${parts.lastName}`.trim();
}

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
