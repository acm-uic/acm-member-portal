import { describe, expect, it } from "vitest";
import type { FormFieldDef } from "../types.ts";
import { submissionAnswers } from "./submission-answers";

const fields: FormFieldDef[] = [
  {
    key: "interests",
    label: "SIG interests",
    type: "multiselect",
    required: false,
    order: 2,
    options: [{ value: "systems", label: "SIG Systems" }],
  },
  {
    key: "college",
    label: "College at signup",
    type: "select",
    required: true,
    order: 1,
    options: [{ value: "engineering", label: "College of Engineering" }],
  },
];

describe("submissionAnswers", () => {
  it("uses saved field and option labels in form order", () => {
    expect(
      submissionAnswers(
        { college: "engineering", interests: ["systems"] },
        fields,
      ),
    ).toEqual([
      {
        key: "college",
        label: "College at signup",
        value: "College of Engineering",
      },
      { key: "interests", label: "SIG interests", value: "SIG Systems" },
    ]);
  });

  it("keeps unknown answers and option values so no submitted data is lost", () => {
    const details = submissionAnswers(
      {
        college: "retired-option",
        interests: ["systems", "retired-sig"],
        old_question: "Original answer",
      },
      fields,
    );
    expect(details.map((field) => field.value)).toEqual([
      "retired-option",
      "SIG Systems, retired-sig",
      "Original answer",
    ]);
    expect(details[2]?.label).toBe("old_question");
  });

  it.each<{ type: FormFieldDef["type"]; answer: string | number }>([
    { type: "text", answer: "engineering" },
    { type: "textarea", answer: "engineering\nnotes" },
    { type: "email", answer: "engineer@example.com" },
    { type: "number", answer: 0 },
  ])("preserves $type answers when old options remain", ({ type, answer }) => {
    const field: FormFieldDef = {
      key: "changed_field",
      label: "Changed field",
      type,
      required: true,
      order: 1,
      options: [{ value: String(answer), label: "Old option label" }],
    };
    expect(submissionAnswers({ changed_field: answer }, [field])).toEqual([
      { key: "changed_field", label: "Changed field", value: String(answer) },
    ]);
  });

  it("distinguishes false and zero from unanswered fields", () => {
    expect(
      submissionAnswers(
        {
          consent: false,
          count: 0,
          confirmed: true,
          empty: "",
          missing: null,
          interests: [],
        },
        [],
      ).map((field) => field.value),
    ).toEqual([
      "No",
      "0",
      "Yes",
      "Not provided",
      "Not provided",
      "Not provided",
    ]);
    expect(submissionAnswers({}, fields).map((field) => field.value)).toEqual([
      "Not provided",
      "Not provided",
    ]);
  });

  it("preserves multiline text and displays answers without a schema", () => {
    expect(
      submissionAnswers(
        { notes: "First line\nSecond line", legacy: { answer: "saved" } },
        [],
      ),
    ).toEqual([
      { key: "notes", label: "notes", value: "First line\nSecond line" },
      { key: "legacy", label: "legacy", value: '{"answer":"saved"}' },
    ]);
    expect(submissionAnswers({}, [])).toEqual([]);
  });
});
