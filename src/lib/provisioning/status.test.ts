import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkWindowsApiHealth, lookupDirectoryUser } from "./status";

describe("Windows API diagnostics", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.stubEnv("WINDOWS_API_URL", "https://windows.test/api/");
    vi.stubEnv("WINDOWS_API_TOKEN", "private-token");
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("checks health without sending the token", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: "ok" }));
    expect(await checkWindowsApiHealth(fetchMock)).toMatchObject({
      ok: true,
      httpStatus: 200,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://windows.test/api/healthz",
      expect.objectContaining({
        headers: {},
        cache: "no-store",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("reports unconfigured API instead of stub success", async () => {
    vi.stubEnv("WINDOWS_API_URL", "");
    expect(await checkWindowsApiHealth(fetchMock)).toMatchObject({
      ok: false,
      httpStatus: null,
      message: "WINDOWS_API_URL is not configured.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a token only for directory lookup", async () => {
    vi.stubEnv("WINDOWS_API_TOKEN", "");
    fetchMock.mockResolvedValue(Response.json({ status: "ok" }));
    expect((await checkWindowsApiHealth(fetchMock)).ok).toBe(true);
    expect(await lookupDirectoryUser("alice", fetchMock)).toMatchObject({
      ok: false,
      exists: null,
      message: "WINDOWS_API_TOKEN is not configured.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([200, 404])(
    "interprets the documented user response for HTTP %i",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json(
          { samAccountName: "alice", existed: status === 200 },
          { status },
        ),
      );
      expect(await lookupDirectoryUser(" alice ", fetchMock)).toMatchObject({
        ok: true,
        username: "alice",
        exists: status === 200,
        httpStatus: status,
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://windows.test/api/users/alice",
        expect.objectContaining({
          headers: { authorization: "Bearer private-token" },
        }),
      );
    },
  );

  it("encodes usernames as a single path segment", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ samAccountName: "alice?#", existed: true }),
    );
    await lookupDirectoryUser("alice?#", fetchMock);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://windows.test/api/users/alice%3F%23",
    );
  });

  it.each(["", " ", ".", "..", "alice/bob", "alice\\bob", "a\nb", "a".repeat(65)])(
    "rejects invalid username %j before sending a request",
    async (username) => {
      expect(await lookupDirectoryUser(username, fetchMock)).toMatchObject({
        ok: false,
        exists: null,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each([401, 403, 502])(
    "does not report backend HTTP %i as an absent account or leak its body",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json({ error: "private-token" }, { status }),
      );
      const result = await lookupDirectoryUser("alice", fetchMock);
      expect(result).toMatchObject({
        ok: false,
        exists: null,
        httpStatus: status,
      });
      expect(JSON.stringify(result)).not.toContain("private-token");
    },
  );

  it("does not interpret a proxy 404 as an absent AD user", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ error: "not found" }, { status: 404 }),
    );
    expect(await lookupDirectoryUser("alice", fetchMock)).toMatchObject({
      ok: false,
      exists: null,
      httpStatus: 404,
    });
  });

  it("reports malformed JSON and an unexpected health payload", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not JSON"));
    expect(await checkWindowsApiHealth(fetchMock)).toMatchObject({
      ok: false,
      httpStatus: 200,
    });
    fetchMock.mockResolvedValueOnce(Response.json({ status: "down" }));
    expect((await checkWindowsApiHealth(fetchMock)).ok).toBe(false);
    fetchMock.mockResolvedValueOnce(
      new Response("<html>not found</html>", { status: 404 }),
    );
    expect(await lookupDirectoryUser("alice", fetchMock)).toMatchObject({
      ok: false,
      exists: null,
      httpStatus: 404,
    });
  });

  it("reports health HTTP errors", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    expect(await checkWindowsApiHealth(fetchMock)).toMatchObject({
      ok: false,
      httpStatus: 503,
    });
  });

  it.each(["TimeoutError", "TypeError"])(
    "reports %s without exposing exception details",
    async (name) => {
      const error = new Error("private-token");
      error.name = name;
      fetchMock.mockRejectedValue(error);
      const health = await checkWindowsApiHealth(fetchMock);
      const lookup = await lookupDirectoryUser("alice", fetchMock);
      expect(health).toMatchObject({ ok: false, httpStatus: null });
      expect(lookup).toMatchObject({
        ok: false,
        exists: null,
        httpStatus: null,
      });
      expect(JSON.stringify([health, lookup])).not.toContain("private-token");
      if (name === "TimeoutError")
        expect(health.message).toContain("10 seconds");
    },
  );
});
