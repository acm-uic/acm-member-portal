import { postedValues } from "~/lib/forms/zod-compiler";

export const SIGNUP_DRAFT_KEY = "acm-signup-draft";

/** Normalize a stored JSON blob into DynamicField `value` props. */
export function parseSignupDraft(
  raw: string | null,
): Record<string, string | string[]> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const values = postedValues(parsed as Record<string, unknown>);
    return Object.keys(values).length ? values : null;
  } catch {
    return null;
  }
}

export function saveSignupDraft(values: Record<string, unknown>): void {
  try {
    sessionStorage.setItem(
      SIGNUP_DRAFT_KEY,
      JSON.stringify(postedValues(values)),
    );
  } catch {
    /* private mode */
  }
}

export function loadSignupDraft(): Record<string, string | string[]> | null {
  try {
    return parseSignupDraft(sessionStorage.getItem(SIGNUP_DRAFT_KEY));
  } catch {
    return null;
  }
}

export function clearSignupDraft(): void {
  try {
    sessionStorage.removeItem(SIGNUP_DRAFT_KEY);
  } catch {
    /* private mode */
  }
}
