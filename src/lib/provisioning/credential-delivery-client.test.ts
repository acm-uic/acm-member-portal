import { describe, expect, it, vi } from "vitest";
import { requestCredentials } from "./credential-delivery-client";

const id = crypto.randomUUID();
const token = crypto.randomUUID();
const reveal = { action: "reveal" as const, id };
const confirm = { action: "confirm" as const, id, token };
const fallback = "Credential delivery failed. Try again.";
const credentials = {
  ok: true,
  username: "asmith",
  oneTimePassword: "temporary-secret",
  token,
};

describe("browser credential delivery requests", () => {
  it("sends an uncached reveal request and returns validated credentials", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(credentials));
    expect(await requestCredentials(reveal, send)).toEqual(credentials);
    expect(send).toHaveBeenCalledWith(
      "/api/signups/credentials/",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reveal),
      }),
    );
  });
  it("confirms copied credentials without expecting a password in the response", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    expect(await requestCredentials(confirm, send)).toEqual({ ok: true });
    expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual(confirm);
  });
  it.each([
    { status: 502, body: "" },
    { status: 503, body: "<html>Private proxy details</html>" },
    { status: 502, body: '{"error":' },
    { status: 502, body: "null" },
    { status: 502, body: "false" },
    { status: 502, body: '"error"' },
    { status: 502, body: '[{"error":"array message"}]' },
    { status: 502, body: '{"error":{"private":"details"}}' },
    { status: 502, body: '{"error":" "}' },
    { status: 502, body: '{"ok":true}' },
    { status: 204, body: null },
    { status: 200, body: "" },
    { status: 200, body: "null" },
    { status: 200, body: '{"ok":true}' },
    {
      status: 200,
      body: JSON.stringify({ ...credentials, oneTimePassword: 123 }),
    },
    {
      status: 200,
      body: JSON.stringify({ ...credentials, oneTimePassword: "" }),
    },
    { status: 200, body: JSON.stringify({ ...credentials, token: null }) },
    { status: 200, body: JSON.stringify({ ...credentials, token: "invalid" }) },
    { status: 200, body: JSON.stringify({ ...credentials, username: null }) },
    { status: 200, body: JSON.stringify({ ...credentials, ok: "true" }) },
  ])(
    "uses a safe message for an invalid reveal response: $status $body",
    async ({ status, body }) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status }));
      await expect(requestCredentials(reveal, send)).rejects.toThrow(fallback);
      expect(send).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["", "null", "<html>proxy error</html>", '{"ok":"true"}'])(
    "uses a safe message for an invalid acknowledgement: %s",
    async (body) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 502 }));
      await expect(requestCredentials(confirm, send)).rejects.toThrow(fallback);
    },
  );
  it.each([reveal, confirm])(
    "uses local messages instead of upstream JSON errors for $action",
    async (data) => {
      const messages = new Map([
        [401, "Sign in to manage signup credentials."],
        [
          403,
          "Reload the page and check your permission to manage signup credentials.",
        ],
        [
          409,
          data.action === "confirm"
            ? "These credentials were replaced or already acknowledged. Refresh status before continuing."
            : "This account is being created or is no longer available for manual delivery. Refresh its status.",
        ],
      ]);
      for (const status of [200, 400, 401, 403, 409, 415, 500, 502, 503]) {
        const send = vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            Response.json(
              { ok: false, error: "Private proxy details: temporary-secret" },
              { status },
            ),
          );
        // Call separately to preserve the request overloads.
        const request =
          data.action === "reveal"
            ? requestCredentials(data, send)
            : requestCredentials(data, send);
        await expect(request).rejects.toThrow(
          new Error(messages.get(status) ?? fallback),
        );
        expect(send).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("handles network failures without exposing browser diagnostics or retrying a reveal", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Private network details"));
    await expect(requestCredentials(reveal, send)).rejects.toThrow(fallback);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
