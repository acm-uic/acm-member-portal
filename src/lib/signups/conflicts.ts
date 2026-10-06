export const signupUsernameConflictMessage =
  "A pending or approved signup already uses this username.";

/** PostgreSQL/PGlite errors may be wrapped in a Drizzle query error. */
export function signupUsernameConflictErrors(
  error: unknown,
): Record<string, string> | null {
  const seen = new Set<unknown>();
  while (typeof error === "object" && error !== null && !seen.has(error)) {
    seen.add(error);
    const details = error as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (details.code === "23505") {
      if (
        details.constraint === "signup_submissions_active_username_key" ||
        details.constraint === "signup_submissions_pending_username_key"
      ) {
        return {
          username: signupUsernameConflictMessage,
        };
      }
    }
    error = details.cause;
  }
  return null;
}
