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
			if (field.min !== undefined)
				n = n.min(field.min, `${field.label} is too small`);
			if (field.max !== undefined)
				n = n.max(field.max, `${field.label} is too large`);
			return field.required ? n : n.optional();
		}
		case "select": {
			const s = z.enum(optionValues(field));
			return field.required ? s : s.optional();
		}
		case "multiselect": {
			const s = z.array(z.enum(optionValues(field)));
			return field.required
				? s.min(1, `Select at least one option for ${field.label}`)
				: s.optional();
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
