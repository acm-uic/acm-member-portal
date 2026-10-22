import { describe, expect, it, vi } from "vitest";
import { handleActivationRequest } from "./activation-http";
import {
  activationUnconfirmed,
  parseActivationResponse,
} from "./activation-response";

const origin = "https://portal.example";
const body = {
  username: " Member ",
  currentPassword: " old ",
  newPassword: " new ",
  confirmPassword: " new ",
};
function request(value: unknown = body, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/activate/`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}
describe("activation HTTP boundary", () => {
  it("normalizes username and preserves password bytes without requiring a session", async () => {
    const activate = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    expect(
      await handleActivationRequest(request(), origin, "trusted", activate),
    ).toEqual({ ok: true, status: 200 });
    expect(activate).toHaveBeenCalledWith(
      { ...body, username: "member" },
      "trusted",
    );
  });
  it.each<Record<string, string>>([
    { origin: "https://evil.example" },
    { origin: "" },
    { "content-type": "text/plain" },
  ])("blocks unsafe headers %j before activation", async (headers) => {
    const activate = vi.fn();
    expect(
      (
        await handleActivationRequest(
          request(body, headers),
          origin,
          "trusted",
          activate,
        )
      ).ok,
    ).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    {},
    { ...body, username: "member@acmuic.org" },
    { ...body, username: "a".repeat(21) },
    { ...body, currentPassword: "" },
    { ...body, newPassword: "a".repeat(257) },
    { ...body, confirmPassword: "mismatch" },
    { ...body, newPassword: " old ", confirmPassword: " old " },
  ])("rejects invalid data %j", async (value) => {
    const activate = vi.fn();
    expect(
      (
        await handleActivationRequest(
          request(value),
          origin,
          "trusted",
          activate,
        )
      ).status,
    ).toBe(400);
    expect(activate).not.toHaveBeenCalled();
  });
  it("enforces body cap without trusting content-length", async () => {
    const activate = vi.fn();
    expect(
      (
        await handleActivationRequest(
          request({ padding: "x".repeat(9000) }),
          origin,
          "trusted",
          activate,
        )
      ).status,
    ).toBe(413);
    expect(activate).not.toHaveBeenCalled();
  });
  it("treats arbitrary browser responses as uncertain without echoing secrets", () => {
    expect(
      parseActivationResponse({ ok: false, error: "private password" }, false),
    ).toEqual({ ok: false, error: activationUnconfirmed, uncertain: true });
    expect(parseActivationResponse({ ok: true }, true)).toEqual({ ok: true });
  });
});
