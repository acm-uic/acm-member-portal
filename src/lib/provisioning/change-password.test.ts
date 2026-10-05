import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeAdPassword } from "./change-password";

describe("changeAdPassword", () => {
  beforeEach(() => {
    vi.stubEnv("WINDOWS_API_URL", "https://directory.example/");
    vi.stubEnv("WINDOWS_API_TOKEN", "test-token");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("sends an encoded account name and exact passwords only to the protected endpoint", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    expect(
      await changeAdPassword("a/b", " old password ", " new password ", send),
    ).toEqual({ ok: true });
    const [url, request] = send.mock.calls[0];
    expect(String(url)).toBe("https://directory.example/users/a%2Fb/password");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer test-token" },
    });
    expect(JSON.parse(request!.body as string)).toEqual({
      currentPassword: " old password ",
      newPassword: " new password ",
    });
  });

  it.each([
    {
      name: "HTML login page",
      status: 200,
      body: "<html>private proxy details</html>",
    },
    { name: "malformed JSON", status: 200, body: '{"ok":' },
    { name: "empty body", status: 200, body: "" },
    { name: "no content", status: 204, body: null },
    {
      name: "unrelated accepted response",
      status: 202,
      body: '{"accepted":true}',
    },
    { name: "missing confirmation", status: 200, body: '{"status":"healthy"}' },
    {
      name: "rejection",
      status: 200,
      body: '{"ok":false,"error":"old-secret"}',
    },
    { name: "string confirmation", status: 200, body: '{"ok":"true"}' },
    { name: "numeric confirmation", status: 200, body: '{"ok":1}' },
    { name: "null", status: 200, body: "null" },
    { name: "boolean", status: 200, body: "true" },
    { name: "array", status: 200, body: '[{"ok":true}]' },
  ])(
    "treats a 2xx $name as an unknown outcome without retrying",
    async ({ status, body }) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status }));
      expect(
        await changeAdPassword("member", "old-secret", "new-secret", send),
      ).toEqual({
        ok: false,
        status: 502,
        error:
          "Could not confirm the password change. Try signing in with your new password before trying again.",
      });
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves AD policy details without truncation", async () => {
    const error =
      "Password history restriction (0x8007052D). " +
      "Detailed directory policy. ".repeat(30);
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error }, { status: 400 }));
    expect(
      await changeAdPassword("member", "old-secret", "new-secret", send),
    ).toEqual({ ok: false, status: 400, error });
  });

  it("redacts passwords if an upstream rejection includes them", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json(
          { error: "Rejected old-secret and new-secret" },
          { status: 400 },
        ),
      );
    expect(
      await changeAdPassword("member", "old-secret", "new-secret", send),
    ).toEqual({
      ok: false,
      status: 400,
      error: "Rejected [redacted] and [redacted]",
    });
  });

  it.each(["WINDOWS_API_URL", "WINDOWS_API_TOKEN"])(
    "fails without %s rather than claiming stub success",
    async (key) => {
      vi.stubEnv(key, "");
      const send = vi.fn<typeof fetch>();
      expect(
        await changeAdPassword("member", "old", "new", send),
      ).toMatchObject({ ok: false, status: 503 });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("refuses to transmit production passwords over HTTP", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WINDOWS_API_URL", "http://directory.example");
    const send = vi.fn<typeof fetch>();
    expect(await changeAdPassword("member", "old", "new", send)).toMatchObject({
      ok: false,
      status: 503,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["not a URL", "ftp://directory.example"])(
    "reports invalid configuration %s as unavailable before sending passwords",
    async (url) => {
      vi.stubEnv("WINDOWS_API_URL", url);
      const send = vi.fn<typeof fetch>();
      expect(
        await changeAdPassword("member", "old", "new", send),
      ).toMatchObject({
        ok: false,
        status: 503,
      });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("uses the documented throttling delay without forwarding upstream headers", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("private proxy details", {
        status: 429,
        headers: { "Retry-After": "arbitrary upstream value" },
      }),
    );
    expect(await changeAdPassword("member", "old", "new", send)).toMatchObject({
      ok: false,
      status: 429,
      retryAfter: 60,
    });
  });

  it.each([
    "private HTML proxy details",
    '{"error":',
    "null",
    "[]",
    "{}",
    '{"error":123}',
    '{"error":""}',
    '{"error":"   "}',
  ])(
    "does not classify invalid HTTP 400 body %s as an AD rejection",
    async (body) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(body, { status: 400 }));
      const result = await changeAdPassword(
        "member",
        "old-secret",
        "new-secret",
        send,
      );
      expect(result).toMatchObject({ ok: false, status: 502 });
      expect(JSON.stringify(result)).not.toContain(
        "private HTML proxy details",
      );
      expect(send).toHaveBeenCalledTimes(1);
    },
  );

  it.each([404, 429, 401, 403, 500, 502, 503])(
    "handles HTTP %s without exposing arbitrary response bodies",
    async (status) => {
      const send = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("private proxy details", { status }));
      const result = await changeAdPassword("member", "old", "new", send);
      expect(result).toMatchObject({
        ok: false,
        status: [401, 403, 503].includes(status)
          ? 503
          : status === 500
            ? 502
            : status,
      });
      expect(JSON.stringify(result)).not.toContain("private proxy details");
      if (status === 429)
        expect(JSON.stringify(result)).toContain("Wait a minute");
    },
  );

  it("does not retry or leak exception text when the outcome is unknown", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("old-secret in private connection details"));
    const result = await changeAdPassword(
      "member",
      "old-secret",
      "new-secret",
      send,
    );
    expect(result).toEqual({
      ok: false,
      status: 502,
      error:
        "Could not confirm the password change. Try signing in with your new password before trying again.",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
