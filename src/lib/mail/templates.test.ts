import { afterEach, describe, expect, it, vi } from "vitest";

const sendMail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./smtp.ts", () => ({ sendMail }));

import { sendCredentialEmail } from "./templates";

afterEach(() => {
  vi.unstubAllEnvs();
  sendMail.mockClear();
});

describe("credential email", () => {
  const credentials = {
    to: "applicant@example.org",
    username: "testmember",
    oneTimePassword: "temporary&private",
  };

  it("delivers the AD activation instructions through the configured portal", async () => {
    vi.stubEnv("ORIGIN", "https://members.example.org/");
    vi.stubEnv("BETTER_AUTH_URL", "https://unused.example.org");

    await sendCredentialEmail(credentials);

    expect(sendMail).toHaveBeenCalledExactlyOnceWith({
      to: credentials.to,
      subject: "Activate your ACM@UIC account",
      text: expect.any(String),
    });
    const message = sendMail.mock.calls[0]![0];
    expect(message.text).toContain("membership has been approved");
    expect(message.text).toContain("AD account has been created");
    expect(message.text).toContain("Username: testmember");
    expect(message.text).toContain("Temporary password: temporary&private");
    expect(message.text).toContain("https://members.example.org/activate/");
    expect(message.text).toContain("https://members.example.org/login/");
    expect(message.text).toContain("synchronize with Microsoft");
    expect(message.text.indexOf("/activate/")).toBeLessThan(
      message.text.indexOf("/login/"),
    );
    expect(message.text).not.toContain("portal.acm-uic.org");
    expect(message.text).not.toContain("change this password at first sign-in");
  });

  it("uses the auth public URL when ORIGIN is not configured", async () => {
    vi.stubEnv("ORIGIN", "");
    vi.stubEnv("BETTER_AUTH_URL", "https://auth.example.org/");
    await sendCredentialEmail(credentials);
    expect(sendMail.mock.calls[0]![0].text).toContain(
      "https://auth.example.org/activate/",
    );
  });

  it("uses the canonical public portal when no origin is configured", async () => {
    vi.stubEnv("ORIGIN", "");
    vi.stubEnv("BETTER_AUTH_URL", "");
    await sendCredentialEmail(credentials);
    expect(sendMail.mock.calls[0]![0].text).toContain(
      "https://portal.acmuic.org/activate/",
    );
  });
});
