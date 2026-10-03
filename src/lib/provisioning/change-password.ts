export type PasswordChangeResult = { ok: true } | { ok: false; error: string };

/** Password changes always require AD; there is deliberately no local stub. */
export async function changeAdPassword(
  samAccountName: string,
  currentPassword: string,
  newPassword: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PasswordChangeResult> {
  const apiUrl = process.env.WINDOWS_API_URL;
  const token = process.env.WINDOWS_API_TOKEN;
  if (!apiUrl || !token) {
    return {
      ok: false,
      error: "Password changes are unavailable. Contact ACM support.",
    };
  }

  try {
    const url = new URL(
      `${apiUrl.replace(/\/$/, "")}/users/${encodeURIComponent(samAccountName)}/password`,
    );
    if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
      return {
        ok: false,
        error:
          "Password changes require a secure directory connection. Contact ACM support.",
      };
    }
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
    if (response.ok) return { ok: true };
    if (response.status === 404) {
      return {
        ok: false,
        error:
          "No Active Directory account was found for your username. Contact ACM support.",
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
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
        "error" in body &&
        typeof body.error === "string"
      ) {
        let error = body.error;
        for (const password of [currentPassword, newPassword]) {
          if (password) error = error.split(password).join("[redacted]");
        }
        return { ok: false, error };
      }
    }
    return {
      ok: false,
      error:
        "Active Directory could not change your password. Contact ACM support.",
    };
  } catch {
    // A timed-out request may have reached AD. Do not retry a password change.
    return {
      ok: false,
      error:
        "Could not confirm the password change. Try signing in with your new password before trying again.",
    };
  }
}
