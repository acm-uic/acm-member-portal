export const activationRejected =
  "Activation could not be completed. Check your username and temporary password, and ensure your new password meets AD policy. If this continues, contact ACM support.";
export const activationUnconfirmed =
  "We could not confirm the password change. Do not submit again. Allow directory synchronization, then try Microsoft sign-in with your new password. Contact ACM support if you cannot sign in.";
export type ActivationResult =
  { ok: true } | { ok: false; error: string; uncertain?: boolean };

/** Never display arbitrary server/proxy content on a page handling passwords. */
export function parseActivationResponse(
  body: unknown,
  ok: boolean,
): ActivationResult {
  if (
    ok &&
    body &&
    typeof body === "object" &&
    "ok" in body &&
    body.ok === true
  )
    return { ok: true };
  if (
    body &&
    typeof body === "object" &&
    "ok" in body &&
    body.ok === false &&
    "error" in body &&
    [
      activationRejected,
      activationUnconfirmed,
      "Too many activation attempts. Wait 15 minutes before trying again.",
      "Activation is unavailable. Contact ACM support.",
    ].includes(String(body.error))
  ) {
    return {
      ok: false,
      error: String(body.error),
      ...(body.error === activationUnconfirmed ? { uncertain: true } : {}),
    };
  }
  return { ok: false, error: activationUnconfirmed, uncertain: true };
}
