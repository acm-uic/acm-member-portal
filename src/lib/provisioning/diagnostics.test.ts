import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeProvisioningError } from "./diagnostics";
import { formatProvisioningTime } from "./log-view";

afterEach(() => vi.unstubAllEnvs());
describe("safe provisioning errors", () => {
  it("redacts credentials in JSON, truncated responses, bearer headers, and free text", () => {
    vi.stubEnv("WINDOWS_API_TOKEN", "configured-secret");
    const error =
      'AD denied; configured-secret; known-password; Bearer abc.def; password=plain; {"oneTimePassword":"quoted-secret","token":"token-secret"}';
    const safe = sanitizeProvisioningError(error, ["known-password"]);
    for (const secret of [
      "configured-secret",
      "known-password",
      "abc.def",
      "plain",
      "quoted-secret",
      "token-secret",
    ])
      expect(safe).not.toContain(secret);
    expect(safe).toContain("AD denied");
    expect(sanitizeProvisioningError('{"password":"truncated')).toBe(
      '{"password":"[redacted]"',
    );
    expect(sanitizeProvisioningError('{"password":"truncated\\')).toBe(
      '{"password":"[redacted]"',
    );
    const jsonSensitiveSecret = 'quote"and\\backslash';
    expect(
      sanitizeProvisioningError(
        JSON.stringify({ error: `Request exposed ${jsonSensitiveSecret}` }),
        [jsonSensitiveSecret],
      ),
    ).toBe('{"error":"Request exposed [redacted]"}');
    const unicodeEscaped =
      'Provisioning API 502: {"error":"Request exposed private\\u0026api-token"}';
    expect(
      sanitizeProvisioningError(unicodeEscaped, ["private&api-token"]),
    ).toBe('Provisioning API 502: {"error":"Request exposed [redacted]"}');
    expect(
      sanitizeProvisioningError(unicodeEscaped.slice(0, -2), [
        "private&api-token",
      ]),
    ).not.toContain("private&api-token");
    expect(
      sanitizeProvisioningError(
        '{"oneTimePassword":"prefix\\u0022credential-tail"}',
        ['prefix"credential-tail'],
      ),
    ).toBe('{"oneTimePassword":"[redacted]"}');
    expect(
      sanitizeProvisioningError(
        '{"error":"Request exposed quote\\u0022and\\\\backslash"}',
        ['quote"and\\backslash'],
      ),
    ).toBe('{"error":"Request exposed [redacted]"}');
    expect(sanitizeProvisioningError("AD failed\0\\u0000")).toBe("AD failed");
  });
});
describe("provisioning timestamps", () => {
  it("shows dates, seconds, and Central daylight or standard time explicitly", () => {
    expect(formatProvisioningTime("2026-10-07T19:14:20.414Z")).toBe(
      "Oct 7, 2026, 2:14:20 PM CDT",
    );
    expect(formatProvisioningTime("2026-01-07T19:14:20.414Z")).toBe(
      "Jan 7, 2026, 1:14:20 PM CST",
    );
  });
});
