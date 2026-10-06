import { BASE_FIELDS, BASE_FIELD_KEYS } from "./fields";
import type { FormSchemaDefinition } from "../types";

/** Edit against the schema saved with the submission, including retired fields. */
export function signupEditFields(
  definition: FormSchemaDefinition,
  includeRestricted: boolean,
) {
  return [
    ...BASE_FIELDS.filter((field) => includeRestricted || field.key !== "uin"),
    ...definition.fields.filter(
      (field) => !(BASE_FIELD_KEYS as readonly string[]).includes(field.key),
    ),
  ].sort((a, b) => a.order - b.order);
}

export function signupEditValues(
  row: {
    firstName: string;
    lastName: string;
    preferredName: string | null;
    netid: string;
    username: string;
    email: string;
    uin?: string | null;
  },
  answers: Record<string, unknown>,
  includeRestricted: boolean,
): Record<string, unknown> {
  const dynamicAnswers = Object.fromEntries(
    Object.entries(answers).filter(
      ([key]) => !(BASE_FIELD_KEYS as readonly string[]).includes(key),
    ),
  );
  return {
    ...dynamicAnswers,
    first_name: row.firstName,
    last_name: row.lastName,
    preferred_name: row.preferredName ?? "",
    netid: row.netid,
    username: row.username,
    email: row.email,
    ...(includeRestricted ? { uin: row.uin ?? "" } : {}),
  };
}
