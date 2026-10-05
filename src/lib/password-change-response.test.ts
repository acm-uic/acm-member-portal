import { describe, expect, it } from "vitest";
import {
  parsePasswordChangeResponse,
  unconfirmedPasswordChangeError,
} from "./password-change-response";

describe("password change response", () => {
  it("requires both a successful status and boolean confirmation", () => {
    expect(parsePasswordChangeResponse({ ok: true }, true)).toEqual({ ok: true });
    expect(parsePasswordChangeResponse({ ok: true }, false)).toEqual({
      ok: false,
      error: unconfirmedPasswordChangeError,
    });
  });

  it("preserves a valid rejection message", () => {
    expect(
      parsePasswordChangeResponse(
        { ok: false, error: "Your current password is incorrect." },
        false,
      ),
    ).toEqual({ ok: false, error: "Your current password is incorrect." });
  });

  it.each([
    null,
    undefined,
    true,
    "true",
    [],
    [{ ok: true }],
    {},
    { ok: "false" },
    { ok: "true" },
    { ok: 1 },
    { ok: false },
    { ok: false, error: "" },
    { ok: false, error: "   " },
    { ok: false, error: 123 },
  ])("reports an unknown outcome for malformed response %j", (body) => {
    expect(parsePasswordChangeResponse(body, true)).toEqual({
      ok: false,
      error: unconfirmedPasswordChangeError,
    });
  });
});
