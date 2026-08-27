import { z } from "zod";
import type { FormFieldDef } from "~/lib/types";
import {
	BASE_FIELD_KEYS,
	USERNAME_PATTERN,
	type BaseFieldKey,
} from "./fields";

/** Campus emails rejected for the personal-email field. */
const CAMPUS_EMAIL_SUFFIXES = ["uic.edu", "uiuc.edu", "illinois.edu"] as const;

function optionValues(field: FormFieldDef): [string, ...string[]] {
	const values = (field.options ?? []).map((o) => o.value);
	if (values.length === 0) {
		throw new Error(`Field "${field.key}" (${field.type}) declares no options`);
	}
	return values as [string, ...string[]];
}

/** "Freshman, Sophomore, or Graduate student" — matches visible option labels. */
function formatOptionLabels(field: FormFieldDef): string {
	const labels = (field.options ?? []).map((o) => o.label);
	if (labels.length === 0) return "a listed option";
	if (labels.length === 1) return labels[0]!;
	if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
	return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

function selectError(field: FormFieldDef) {
	return (iss: { input: unknown }) => {
		if (iss.input === undefined || iss.input === "") {
			return `${field.label} is required`;
		}
		return `Choose ${formatOptionLabels(field)}`;
	};
}

/** HTML checkboxes post a string when one is checked, an array when several are. */
function asStringArray(val: unknown): unknown {
	if (val == null || val === "") return [];
	return Array.isArray(val) ? val : [val];
}

function endsWithCampusDomain(email: string): boolean {
	const lower = email.trim().toLowerCase();
	const at = lower.lastIndexOf("@");
	if (at < 0) return false;
	const host = lower.slice(at + 1);
	return CAMPUS_EMAIL_SUFFIXES.some(
		(suffix) => host === suffix || host.endsWith(`.${suffix}`),
	);
}

/** Compile one admin-defined field to a Zod schema (Zod v4). */
export function compileField(field: FormFieldDef): z.ZodTypeAny {
	switch (field.type) {
		case "text":
		case "textarea": {
			let s = z.string().trim();
			if (field.key === "uin") {
				s = s.regex(
					/^\d{9,}$/,
					`${field.label} must be at least 9 digits (leading zeros are fine)`,
				);
			}
			if (field.key === "username") {
				s = s.regex(
					USERNAME_PATTERN,
					`${field.label} can only contain letters and numbers`,
				);
			}
			if (field.minLength !== undefined)
				s = s.min(
					field.minLength,
					`${field.label} must be at least ${field.minLength} characters`,
				);
			if (field.maxLength)
				s = s.max(field.maxLength, `${field.label} is too long`);
			return field.required
				? s.min(1, `${field.label} is required`)
				: s.optional().or(z.literal(""));
		}
		case "email": {
			let s: z.ZodTypeAny = z.email("Enter a valid email address");
			if (field.key === "email") {
				s = s.refine(
					(val) => typeof val !== "string" || !endsWithCampusDomain(val),
					"Use a personal email — not one ending in uic.edu, uiuc.edu, or illinois.edu",
				);
			}
			return field.required ? s : s.optional().or(z.literal(""));
		}
		case "number": {
			let n = z.coerce.number<number>().int("Enter a whole number");
			if (field.min !== undefined)
				n = n.min(field.min, `${field.label} must be at least ${field.min}`);
			if (field.max !== undefined)
				n = n.max(field.max, `${field.label} must be at most ${field.max}`);
			return field.required ? n : n.optional();
		}
		case "select": {
			const s = z.enum(optionValues(field), { error: selectError(field) });
			return field.required ? s : s.optional();
		}
		case "multiselect": {
			const item = z.enum(optionValues(field), { error: selectError(field) });
			const arr = field.required
				? z.array(item).min(1, `Select at least one option for ${field.label}`)
				: z.array(item);
			return z.preprocess(asStringArray, arr);
		}
		case "checkbox":
			return z.coerce.boolean();
	}
}

/**
 * Compile a full form (base + dynamic) to one object schema.
 * Past graduation years are allowed only when Year in school is Alum.
 */
export function compileFormSchema(fields: FormFieldDef[]) {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const field of fields) shape[field.key] = compileField(field);
	return z.object(shape).superRefine((data, ctx) => {
		if (!("grad_year" in data) || !("year_in_school" in data)) return;
		const gradYear = data.grad_year;
		const yearInSchool = data.year_in_school;
		if (typeof gradYear !== "number") return;
		if (yearInSchool === "alumni") return;
		const currentYear = new Date().getFullYear();
		if (gradYear < currentYear) {
			ctx.addIssue({
				code: "custom",
				path: ["grad_year"],
				message: `Expected graduation year must be ${currentYear} or a later year unless Year in school is Alum`,
			});
		}
	});
}

/**
 * Split validated output into base columns (signup_submissions columns)
 * and dynamic answers (JSONB). Unknown keys are impossible post-safeParse.
 */
export function splitAnswers(data: Record<string, unknown>): {
	base: Record<BaseFieldKey, string>;
	answers: Record<string, unknown>;
} {
	const base = {} as Record<BaseFieldKey, string>;
	const answers: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if ((BASE_FIELD_KEYS as readonly string[]).includes(key)) {
			base[key as BaseFieldKey] = value as string;
		} else {
			answers[key] = value;
		}
	}
	return { base, answers };
}

export function flattenFieldErrors(
	flat: Record<string, string[] | undefined>,
): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const [key, msgs] of Object.entries(flat)) {
		if (msgs?.length) errors[key] = msgs[0]!;
	}
	return errors;
}

/** Posted form values used to rehydrate inputs after a failed submit. */
export function postedValues(
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

/** Read a form element into the shape `compileFormSchema` expects. */
export function valuesFromFormElement(
	form: HTMLFormElement,
	fields: FormFieldDef[],
): Record<string, unknown> {
	const fd = new FormData(form);
	const data: Record<string, unknown> = {};
	for (const field of fields) {
		if (field.type === "multiselect") {
			data[field.key] = fd.getAll(field.key).map(String);
		} else if (field.type === "checkbox") {
			data[field.key] = fd.get(field.key) != null;
		} else {
			data[field.key] = String(fd.get(field.key) ?? "");
		}
	}
	return data;
}

/** Client-side mirror of server `compileFormSchema` field errors. */
export function clientFieldErrors(
	fields: FormFieldDef[],
	data: Record<string, unknown>,
): Record<string, string> {
	const parsed = compileFormSchema(fields).safeParse(data);
	if (parsed.success) return {};
	return flattenFieldErrors(parsed.error.flatten().fieldErrors);
}

/** Snapshot of identity + dynamic answers for profile audit diffs. */
export function profileSnapshot(data: Record<string, unknown>): Record<
	string,
	unknown
> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;
		out[key] = value;
	}
	return out;
}

function isEmptyValue(value: unknown): boolean {
	if (value == null || value === "") return true;
	if (Array.isArray(value) && value.length === 0) return true;
	return false;
}

export function changedFields(
	before: Record<string, unknown>,
	after: Record<string, unknown>,
): { field: string; oldValue: unknown; newValue: unknown }[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	const changes: { field: string; oldValue: unknown; newValue: unknown }[] =
		[];
	for (const key of keys) {
		const oldValue = before[key] ?? null;
		const newValue = after[key] ?? null;
		if (isEmptyValue(oldValue) && isEmptyValue(newValue)) continue;
		if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
			changes.push({ field: key, oldValue, newValue });
		}
	}
	return changes;
}
