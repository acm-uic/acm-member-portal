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

	it("asks for the current year or later when grad_year is too small", () => {
		const parsed = schema.safeParse({ ...validInput, grad_year: "1" });
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		const msg = parsed.error.flatten().fieldErrors.grad_year?.[0] ?? "";
		const year = String(new Date().getFullYear());
		expect(msg).toContain(year);
		expect(msg).toMatch(/later year/);
		expect(msg).not.toMatch(/too small/);
	});

	it("reports select errors with visible labels, not option values", () => {
		const parsed = schema.safeParse({ ...validInput, college: "hogwarts" });
		expect(parsed.success).toBe(false);
		if (parsed.success) return;
		const msg = parsed.error.flatten().fieldErrors.college?.[0] ?? "";
		expect(msg).toContain("College of Engineering");
		expect(msg).not.toMatch(/"engineering"/);
	});

	it("coerces a single checkbox value into a multiselect array", () => {
		const parsed = schema.safeParse({
			...validInput,
			sig_interest: "sig-ai",
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.sig_interest).toEqual(["sig-ai"]);
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

	it("accepts the select value while naming labels in the error", () => {
		const yearInSchool = compileField({
			key: "year_in_school",
			label: "Year in school",
			type: "select",
			required: true,
			order: 3,
			options: [
				{ value: "freshman", label: "Freshman" },
				{ value: "sophomore", label: "Sophomore" },
				{ value: "junior", label: "Junior" },
				{ value: "senior", label: "Senior" },
				{ value: "grad", label: "Graduate student" },
			],
		});
		expect(yearInSchool.safeParse("grad").success).toBe(true);
		const bad = yearInSchool.safeParse("Graduate student");
		expect(bad.success).toBe(false);
		if (bad.success) return;
		expect(bad.error.issues[0]?.message).toContain("Graduate student");
		expect(bad.error.issues[0]?.message).not.toMatch(/"grad"/);
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
