type RevealRequest = { action: "reveal"; id: string };
type ConfirmRequest = { action: "confirm"; id: string; token: string };
type RevealedCredentials = {
  ok: true;
  username: string;
  oneTimePassword: string;
  token: string;
};

const deliveryError = "Credential delivery failed. Try again.";

export function requestCredentials(
  data: RevealRequest,
  fetchImpl?: typeof fetch,
): Promise<RevealedCredentials>;
export function requestCredentials(
  data: ConfirmRequest,
  fetchImpl?: typeof fetch,
): Promise<{ ok: true }>;
/** Browser requests must not expose JSON parser errors or proxy response bodies. */
export async function requestCredentials(
  data: RevealRequest | ConfirmRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RevealedCredentials | { ok: true }> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl("/api/signups/credentials/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(data),
    });
    body = await response.json();
  } catch {
    throw new Error(deliveryError);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(deliveryError);
  }
  if (!response.ok || !("ok" in body) || body.ok !== true) {
    throw new Error(
      "error" in body && typeof body.error === "string" && body.error.trim()
        ? body.error
        : deliveryError,
    );
  }
  if (data.action === "confirm") return { ok: true };
  if (
    !("username" in body) ||
    typeof body.username !== "string" ||
    !body.username ||
    !("oneTimePassword" in body) ||
    typeof body.oneTimePassword !== "string" ||
    !body.oneTimePassword ||
    !("token" in body) ||
    typeof body.token !== "string" ||
    !body.token
  ) {
    throw new Error(deliveryError);
  }
  return {
    ok: true,
    username: body.username,
    oneTimePassword: body.oneTimePassword,
    token: body.token,
  };
}
