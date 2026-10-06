export const signupUsernameConflictMessage =
  "This username is already in use or reserved by a pending or approved signup.";

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
        details.constraint === "signup_submissions_pending_username_key" ||
        details.constraint === "username_claims_username_key"
      ) {
        return {
          username: signupUsernameConflictMessage,
        };
      }
      if (
        details.constraint === "user_username_unique" ||
        details.constraint === "user_username_key"
      ) {
        return { username: "This username is already in use." };
      }
    }
    error = details.cause;
  }
  return null;
}
