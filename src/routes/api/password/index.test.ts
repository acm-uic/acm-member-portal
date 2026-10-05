import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  change: vi.fn(),
  where: vi.fn(),
}));
vi.mock("~/lib/db", () => ({ db: { select: mocks.select } }));
vi.mock("~/lib/provisioning/change-password", () => ({
  changeAdPassword: mocks.change,
}));
import { onPost } from "./index";

const valid = {
  currentPassword: " old-secret ",
  newPassword: " new-secret ",
  confirmPassword: " new-secret ",
};

async function request(
  body: unknown = valid,
  options: {
    authenticated?: boolean;
    origin?: string | null;
    contentType?: string;
    raw?: string;
  } = {},
) {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
  });
  if (options.origin !== null)
    headers.set("origin", options.origin ?? "https://portal.example");
  const json = vi.fn();
  const responseHeaders = new Headers();
  await onPost({
    request: new Request("https://portal.example/api/password", {
      method: "POST",
      headers,
      body: options.raw ?? JSON.stringify(body),
    }),
    sharedMap: new Map([
      [
        "session",
        options.authenticated === false
          ? null
          : { user: { id: "signed-in-member", username: "stale-account" } },
      ],
    ]),
    url: new URL("https://portal.example/api/password"),
    headers: responseHeaders,
    json,
  } as unknown as Parameters<typeof onPost>[0]);
  return { json, responseHeaders };
}

describe("password endpoint", () => {
  beforeEach(() => {
    vi.stubEnv("ORIGIN", "https://portal.example");
    mocks.select.mockReset();
    mocks.where.mockReset();
    mocks.where.mockReturnValue({
      limit: async () => [{ username: "current-account", netid: "netid" }],
    });
    mocks.select.mockReturnValue({
      from: () => ({
        where: mocks.where,
      }),
    });
    mocks.change.mockReset();
    mocks.change.mockResolvedValue({ ok: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires authentication before reading account data or contacting AD", async () => {
    const { json } = await request(valid, { authenticated: false });
    expect(json).toHaveBeenCalledWith(
      401,
      expect.objectContaining({ ok: false }),
    );
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it.each(["https://attacker.example", null])(
    "rejects an untrusted or missing origin: %s",
    async (origin) => {
      const { json } = await request(valid, { origin });
      expect(json).toHaveBeenCalledWith(403, expect.anything());
      expect(mocks.change).not.toHaveBeenCalled();
    },
  );

  it("rejects non-JSON requests", async () => {
    const { json } = await request(valid, { contentType: "text/plain" });
    expect(json).toHaveBeenCalledWith(415, expect.anything());
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { ...valid, currentPassword: "" },
    { ...valid, newPassword: 123 },
    { ...valid, confirmPassword: "different" },
    { ...valid, confirmPassword: undefined },
    { currentPassword: "same", newPassword: "same", confirmPassword: "same" },
  ])("rejects invalid inputs before contacting AD: %j", async (body) => {
    const { json } = await request(body);
    expect(json).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ ok: false }),
    );
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const { json } = await request(valid, { raw: "{" });
    expect(json).toHaveBeenCalledWith(400, expect.anything());
    expect(mocks.change).not.toHaveBeenCalled();
  });

  it("uses the member's current DB account name, ignoring a submitted target and stale session", async () => {
    const { json, responseHeaders } = await request({
      ...valid,
      samAccountName: "another-member",
      userId: "another-id",
    });
    expect(mocks.change).toHaveBeenCalledWith(
      "current-account",
      " old-secret ",
      " new-secret ",
    );
    const query = new PgDialect().sqlToQuery(
      mocks.where.mock.calls[0][0] as SQL,
    );
    expect(query.sql).toBe('"user"."id" = $1');
    expect(query.params).toEqual(["signed-in-member"]);
    expect(json).toHaveBeenCalledWith(200, { ok: true });
    expect(JSON.stringify(json.mock.calls)).not.toContain("secret");
    expect(responseHeaders.get("cache-control")).toBe("no-store");
  });

  it("shows an AD rejection without reflecting submitted passwords", async () => {
    const error =
      "AD password history policy rejected this password (0x8007052D).";
    mocks.change.mockResolvedValue({ ok: false, status: 400, error });
    const { json } = await request();
    expect(json).toHaveBeenCalledWith(400, { ok: false, error });
    expect(JSON.stringify(json.mock.calls)).not.toContain("secret");
  });

  it.each([400, 404, 502, 503])(
    "preserves the server failure status %s with the public response body",
    async (status) => {
      const error = "Directory failure details";
      mocks.change.mockResolvedValue({ ok: false, status, error });
      const { json, responseHeaders } = await request();
      expect(json).toHaveBeenCalledWith(status, { ok: false, error });
      expect(responseHeaders.get("retry-after")).toBeNull();
      expect(responseHeaders.get("cache-control")).toBe("no-store");
    },
  );

  it("preserves throttling with the documented retry delay", async () => {
    const error =
      "Too many password change attempts. Wait a minute and try again.";
    mocks.change.mockResolvedValue({
      ok: false,
      status: 429,
      retryAfter: 60,
      error,
    });
    const { json, responseHeaders } = await request();
    expect(json).toHaveBeenCalledWith(429, { ok: false, error });
    expect(responseHeaders.get("retry-after")).toBe("60");
    expect(responseHeaders.get("cache-control")).toBe("no-store");
  });

  it("does not contact AD for a deleted account or one without an account name", async () => {
    mocks.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    });
    const { json } = await request();
    expect(json).toHaveBeenCalledWith(
      400,
      expect.objectContaining({ ok: false }),
    );
    expect(mocks.change).not.toHaveBeenCalled();
  });
});
