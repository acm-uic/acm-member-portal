/** PostgreSQL/PGlite errors may be wrapped in a Drizzle query error. */
export function pendingSignupConflictErrors(
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
      if (details.constraint === "signup_submissions_pending_netid_key") {
        return { netid: "A signup with this NetID is already pending review." };
      }
      if (details.constraint === "signup_submissions_pending_username_key") {
        return {
          username: "A signup with this username is already pending review.",
        };
      }
    }
    error = details.cause;
  }
  return null;
}
