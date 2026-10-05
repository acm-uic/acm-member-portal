import type { FormFieldDef } from "../types.ts";

function formatAnswer(value: unknown, field?: FormFieldDef): string {
  if (value == null || value === "") return "Not provided";
  if (Array.isArray(value)) {
    return value.length
      ? value.map((item) => formatAnswer(item, field)).join(", ")
      : "Not provided";
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  if (field?.type === "select" || field?.type === "multiselect") {
    return (
      field.options?.find((option) => option.value === String(value))?.label ??
      String(value)
    );
  }
  return String(value);
}

/** Use the submission's saved schema, including fields that are now retired. */
export function submissionAnswers(
  answers: Record<string, unknown>,
  fields: FormFieldDef[],
): { key: string; label: string; value: string }[] {
  const orderedFields = [...fields].sort((a, b) => a.order - b.order);
  const fieldKeys = new Set(fields.map((field) => field.key));
  return [
    ...orderedFields.map((field) => ({
      key: field.key,
      label: field.label,
      value: formatAnswer(answers[field.key], field),
    })),
    ...Object.entries(answers)
      .filter(([key]) => !fieldKeys.has(key))
      .map(([key, value]) => ({ key, label: key, value: formatAnswer(value) })),
  ];
}
