import { z } from "zod";
import type { FormFieldDef } from "~/lib/types";
import { BASE_FIELD_KEYS, type BaseFieldKey } from "./fields";

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

function numberMin(field: FormFieldDef): { min: number; message: string } | null {
	if (field.min === undefined) return null;
	const currentYear = new Date().getFullYear();
	const looksLikeYear = field.min >= 1900 && field.min <= currentYear + 80;
	if (looksLikeYear) {
		const min = Math.max(field.min, currentYear);
		return { min, message: `${field.label} must be ${min} or a later year` };
	}
	return {
		min: field.min,
		message: `${field.label} must be at least ${field.min}`,
	};
}

/** Compile one admin-defined field to a Zod schema (Zod v4). */
export function compileField(field: FormFieldDef): z.ZodTypeAny {
	switch (field.type) {
		case "text":
		case "textarea": {
			let s = z.string().trim();
			if (field.maxLength)
				s = s.max(field.maxLength, `${field.label} is too long`);
			return field.required
				? s.min(1, `${field.label} is required`)
				: s.optional().or(z.literal(""));
		}
		case "email": {
			const s = z.email("Enter a valid email address");
			return field.required ? s : s.optional().or(z.literal(""));
		}
		case "number": {
			let n = z.coerce.number<number>().int("Enter a whole number");
			const bound = numberMin(field);
			if (bound) n = n.min(bound.min, bound.message);
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

/** Compile a full form (base + dynamic) to one object schema. */
export function compileFormSchema(fields: FormFieldDef[]) {
	const shape: Record<string, z.ZodTypeAny> = {};
	for (const field of fields) shape[field.key] = compileField(field);
	return z.object(shape);
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
