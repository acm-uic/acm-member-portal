import type { PasswordChangeResult } from "~/lib/provisioning/change-password";

export const unconfirmedPasswordChangeError =
  "Could not confirm the password change. Try signing in with your new password before trying again.";

export function parsePasswordChangeResponse(
  body: unknown,
  successfulStatus: boolean,
): PasswordChangeResult {
  if (body && typeof body === "object" && !Array.isArray(body) && "ok" in body) {
    if (successfulStatus && body.ok === true) return { ok: true };
    if (
      body.ok === false &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error.trim().length > 0
    ) {
      return { ok: false, error: body.error };
    }
  }
  return { ok: false, error: unconfirmedPasswordChangeError };
}
