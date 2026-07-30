import { describe, expect, it } from "vitest";
import { compileField, compileFormSchema, splitAnswers } from "./zod-compiler";
import { BASE_FIELDS } from "./fields";
import type { FormFieldDef } from "~/lib/types";

const dynamicFields: FormFieldDef[] = [
	{
		key: "major",
		label: "Major",
		type: "text",
		required: true,
		order: 2,
		maxLength: 120,
	},
	{
		key: "grad_year",
		label: "Expected graduation year",
		type: "number",
		required: true,
		order: 4,
		min: 2024,
		max: 2040,
	},
	{
		key: "sig_interest",
		label: "Interest in SIGs",
		type: "multiselect",
		required: false,
		order: 5,
		options: [
			{ value: "sig-systems", label: "SIG Systems" },
			{ value: "sig-ai", label: "SIG AI" },
		],
	},
	{
		key: "college",
		label: "College",
		type: "select",
		required: true,
		order: 1,
		options: [
			{ value: "engineering", label: "College of Engineering" },
			{ value: "other", label: "Other" },
		],
	},
];

const schema = compileFormSchema([...BASE_FIELDS, ...dynamicFields]);

const validInput = {
	display_name: "Alex Morgan",
	netid: "amorga42",
	uin: "678901234",
	email: "alex@example.com",
	major: "Computer Science",
	grad_year: "2028", // coerced
	sig_interest: ["sig-ai"],
	college: "engineering",
};

describe("compileFormSchema", () => {
	it("accepts a valid full submission and coerces numbers", () => {
		const parsed = schema.safeParse(validInput);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.grad_year).toBe(2028);
	});

	it("rejects a missing required base field", () => {
		const { netid: _omit, ...rest } = validInput;
		expect(schema.safeParse(rest).success).toBe(false);
	});

	it("rejects a missing required dynamic field", () => {
		const { major: _omit, ...rest } = validInput;
		expect(schema.safeParse(rest).success).toBe(false);
	});

	it("rejects an out-of-range grad_year", () => {
		expect(schema.safeParse({ ...validInput, grad_year: "2050" }).success).toBe(
			false,
		);
	});

	it("rejects an invalid email", () => {
		expect(
			schema.safeParse({ ...validInput, email: "not-an-email" }).success,
		).toBe(false);
	});

	it("rejects a select value outside the declared options", () => {
		expect(
			schema.safeParse({ ...validInput, college: "hogwarts" }).success,
		).toBe(false);
	});

	it("allows the optional multiselect to be omitted", () => {
		const { sig_interest: _omit, ...rest } = validInput;
		expect(schema.safeParse(rest).success).toBe(true);
	});

	it("enforces maxLength on text fields", () => {
		expect(
			schema.safeParse({ ...validInput, major: "x".repeat(121) }).success,
		).toBe(false);
	});
});

describe("compileField", () => {
	it("throws for an option-typed field with no options", () => {
		expect(() =>
			compileField({
				key: "broken",
				label: "Broken",
				type: "select",
				required: true,
				order: 1,
			}),
		).toThrow(/no options/);
	});
});

describe("splitAnswers", () => {
	it("separates base columns from dynamic answers", () => {
		const parsed = schema.parse(validInput);
		const { base, answers } = splitAnswers(parsed);
		expect(base).toEqual({
			display_name: "Alex Morgan",
			netid: "amorga42",
			uin: "678901234",
			email: "alex@example.com",
		});
		expect(Object.keys(answers).sort()).toEqual([
			"college",
			"grad_year",
			"major",
			"sig_interest",
		]);
	});
});
