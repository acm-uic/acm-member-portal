import { describe, expect, it } from "vitest";
import {
  accountOnboardingUrls,
  credentialDeliveryInstructions,
} from "./credential-instructions";

describe("credential delivery instructions", () => {
  it("links to activation before Microsoft sign-in using the configured public origin", () => {
    const text = credentialDeliveryInstructions({
      username: "testmember",
      oneTimePassword: "temporary&private",
      publicOrigin: "https://members.example.org/",
    });

    expect(text).toContain(
      "Username: testmember\nTemporary password: temporary&private",
    );
    expect(text).toContain(
      "1. Activate your account at https://members.example.org/activate/",
    );
    expect(text).toContain("choose a new password");
    expect(text).toContain("2. Allow up to 30 minutes");
    expect(text).toContain(
      '3. Visit https://members.example.org/login/ and choose "Sign in with Microsoft" using your ACM email address and new password.',
    );
    expect(text).toContain(
      "Use the temporary password only on the activation page.",
    );
    for (const link of text.match(/https?:\/\/\S+/g) ?? []) {
      const url = new URL(link);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(link).not.toContain("testmember");
      expect(link).not.toContain("temporary");
    }
  });

  it.each([undefined, "", "invalid-origin", "javascript:alert(1)"])(
    "falls back to the canonical portal for an absent or invalid origin: %s",
    (origin) => {
      expect(accountOnboardingUrls(origin)).toEqual({
        activation: "https://portal.acmuic.org/activate/",
        login: "https://portal.acmuic.org/login/",
      });
    },
  );

  it("uses only the configured origin without credentials, query parameters, or fragments", () => {
    expect(
      accountOnboardingUrls(
        "https://user:secret@members.example.org/path?q=secret#secret",
      ),
    ).toEqual({
      activation: "https://members.example.org/activate/",
      login: "https://members.example.org/login/",
    });
  });

  it("supports a configured local-development origin", () => {
    expect(accountOnboardingUrls("http://localhost:5173").activation).toBe(
      "http://localhost:5173/activate/",
    );
  });
});
