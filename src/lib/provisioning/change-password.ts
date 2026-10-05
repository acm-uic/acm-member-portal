export type PasswordChangeResult = { ok: true } | { ok: false; error: string };

export type PasswordChangeServerResult =
  | { ok: true }
  | { ok: false; error: string; status: 400 | 404 | 502 | 503 }
  | { ok: false; error: string; status: 429; retryAfter: 60 };

const unconfirmedPasswordChangeError =
  "Could not confirm the password change. Try signing in with your new password before trying again.";

/** Password changes always require AD; there is deliberately no local stub. */
export async function changeAdPassword(
  samAccountName: string,
  currentPassword: string,
  newPassword: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasswordChangeServerResult> {
  const apiUrl = process.env.WINDOWS_API_URL;
  const token = process.env.WINDOWS_API_TOKEN;
  if (!apiUrl || !token) {
    return {
      ok: false,
      status: 503,
      error: "Password changes are unavailable. Contact ACM support.",
    };
  }

  let url: URL;
  try {
    url = new URL(
      `${apiUrl.replace(/\/$/, "")}/users/${encodeURIComponent(samAccountName)}/password`,
    );
  } catch {
    return {
      ok: false,
      status: 503,
      error: "Password changes are unavailable. Contact ACM support.",
    };
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    (process.env.NODE_ENV === "production" && url.protocol !== "https:")
  ) {
    return {
      ok: false,
      status: 503,
      error:
        "Password changes require a secure directory connection. Contact ACM support.",
    };
  }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (response.ok) {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        "ok" in body &&
        body.ok === true
      ) {
        return { ok: true };
      }
      return { ok: false, status: 502, error: unconfirmedPasswordChangeError };
    }
    if (response.status === 404) {
      return {
        ok: false,
        status: 404,
        error:
          "No Active Directory account was found for your username. Contact ACM support.",
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        status: 429,
        retryAfter: 60,
        error:
          "Too many password change attempts. Wait a minute and try again.",
      };
    }
    // Only expected AD rejections are user-visible. Never echo an HTML proxy error.
    if (response.status === 400) {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        "error" in body &&
        typeof body.error === "string" &&
        body.error.trim().length > 0
      ) {
        let error = body.error;
        const passwords = [currentPassword, newPassword]
          .filter((password) => password.length > 0)
          .sort((a, b) => b.length - a.length)
          .map((password) => password.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        if (passwords.length > 0) {
          error = error.replace(
            new RegExp(passwords.join("|"), "g"),
            "[redacted]",
          );
        }
        return { ok: false, status: 400, error };
      }
    }
    return {
      ok: false,
      status: [401, 403, 503].includes(response.status) ? 503 : 502,
      error:
        "Active Directory could not change your password. Contact ACM support.",
    };
  } catch {
    // AD may have changed the password even if its confirmation is unavailable.
    // Do not retry a password change.
    return {
      ok: false,
      status: 502,
      error: unconfirmedPasswordChangeError,
    };
  }
}
