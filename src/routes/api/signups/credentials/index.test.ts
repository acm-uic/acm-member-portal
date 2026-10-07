import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  permissions: vi.fn(),
  reveal: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("~/lib/rbac/guards", () => ({ getPermissions: mocks.permissions }));
vi.mock("~/lib/provisioning/manual-delivery", () => ({
  revealManualCredentials: mocks.reveal,
  confirmManualDelivery: mocks.confirm,
  ManualDeliveryError: class extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
}));
import { onPost } from "./index";
import { ManualDeliveryError } from "~/lib/provisioning/manual-delivery";

const id = crypto.randomUUID();
const token = crypto.randomUUID();
async function request(
  body: unknown = { action: "reveal", id },
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
  const responseHeaders = new Headers();
  const json = vi.fn();
  await onPost({
    request: new Request("https://portal.example/api/signups/credentials/", {
      method: "POST",
      headers,
      body: options.raw ?? JSON.stringify(body),
    }),
    sharedMap: new Map([
      [
        "session",
        options.authenticated === false ? null : { user: { id: "reviewer" } },
      ],
    ]),
    url: new URL("https://portal.example/api/signups/credentials/"),
    headers: responseHeaders,
    json,
  } as unknown as Parameters<typeof onPost>[0]);
  expect(responseHeaders.get("Cache-Control")).toBe("no-store");
  return json;
}

describe("manual signup credential endpoint", () => {
  beforeEach(() => {
    vi.stubEnv("ORIGIN", "https://portal.example");
    vi.resetAllMocks();
    mocks.permissions.mockResolvedValue(
      new Set(["signups.approve", "signups.review"]),
    );
    mocks.reveal.mockResolvedValue({
      ok: true,
      username: "asmith",
      oneTimePassword: "temporary-secret",
      token,
    });
    mocks.confirm.mockResolvedValue(true);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires a signed-in admin before resolving permissions or creating credentials", async () => {
    const json = await request(undefined, { authenticated: false });
    expect(json).toHaveBeenCalledWith(401, expect.anything());
    expect(mocks.permissions).not.toHaveBeenCalled();
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
  it.each([[], ["signups.review"], ["signups.approve"]])(
    "requires review and approval permission: %j",
    async (...permissions) => {
      mocks.permissions.mockResolvedValue(new Set(permissions));
      const json = await request();
      expect(json).toHaveBeenCalledWith(403, expect.anything());
      expect(mocks.reveal).not.toHaveBeenCalled();
    },
  );
  it.each(["https://attacker.example", null])(
    "rejects requests with an untrusted or absent origin: %s",
    async (origin) => {
      const json = await request(undefined, { origin });
      expect(json).toHaveBeenCalledWith(403, expect.anything());
      expect(mocks.reveal).not.toHaveBeenCalled();
    },
  );
  it("rejects non-JSON requests and malformed JSON", async () => {
    expect(
      await request(undefined, { contentType: "text/plain" }),
    ).toHaveBeenCalledWith(415, expect.anything());
    expect(await request(undefined, { raw: "{" })).toHaveBeenCalledWith(
      400,
      expect.anything(),
    );
    expect(mocks.reveal).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { action: "reveal", id: "invalid" },
    { action: "confirm", id },
    { action: "confirm", id, token: "invalid" },
  ])(
    "validates event and acknowledgement before creating credentials: %j",
    async (body) => {
      const json = await request(body);
      expect(json).toHaveBeenCalledWith(400, expect.anything());
      expect(mocks.reveal).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
    },
  );
  it("returns credentials only in the authorized uncached reveal response", async () => {
    const json = await request({
      action: "reveal",
      id,
      username: "another-user",
      actorId: "another-admin",
    });
    expect(mocks.reveal).toHaveBeenCalledWith(id, "reviewer");
    expect(json).toHaveBeenCalledWith(200, {
      ok: true,
      username: "asmith",
      oneTimePassword: "temporary-secret",
      token,
    });
  });
  it("confirms the current receipt without returning credentials", async () => {
    const json = await request({ action: "confirm", id, token });
    expect(mocks.confirm).toHaveBeenCalledWith(id, token, "reviewer");
    expect(mocks.reveal).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(200, { ok: true });
  });
  it("rejects an acknowledgement superseded by another reveal", async () => {
    mocks.confirm.mockResolvedValue(false);
    expect(
      await request({ action: "confirm", id, token }),
    ).toHaveBeenCalledWith(409, expect.objectContaining({ ok: false }));
  });
  it("preserves a safe conflict message, hiding unexpected downstream error details", async () => {
    mocks.reveal.mockRejectedValueOnce(
      new ManualDeliveryError("Account is busy.", 409),
    );
    expect(await request()).toHaveBeenCalledWith(409, {
      ok: false,
      error: "Account is busy.",
    });
    mocks.reveal.mockRejectedValueOnce(
      new Error("Failed to save temporary-secret"),
    );
    const json = await request();
    expect(json).toHaveBeenCalledWith(
      503,
      expect.objectContaining({ ok: false }),
    );
    expect(JSON.stringify(json.mock.calls)).not.toContain("temporary-secret");
  });
});
