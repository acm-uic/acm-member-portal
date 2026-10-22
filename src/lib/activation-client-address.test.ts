import { describe, expect, it } from "vitest";
import { trustedActivationClientAddress } from "./activation-client-address";

describe("activation connection identity", () => {
  it("ignores spoofed forwarding headers and prefers the socket over adapter metadata", () => {
    const request = new Request("https://portal.example/api/activate/", {
      headers: {
        "x-forwarded-for": "203.0.113.1",
        "x-real-ip": "203.0.113.2",
      },
    });
    expect(
      trustedActivationClientAddress({
        request,
        platform: {
          incomingMessage: { socket: { remoteAddress: "10.0.0.8" } },
        },
        clientConn: { ip: "203.0.113.3" },
      }),
    ).toBe("10.0.0.8");
  });

  it("keeps equivalent IPv4 socket representations in the same bucket", () => {
    const addresses = ["192.0.2.10", "::ffff:192.0.2.10", "::FFFF:192.0.2.10"];
    expect(
      addresses.map((ip) =>
        trustedActivationClientAddress({ clientConn: { ip } }),
      ),
    ).toEqual(["192.0.2.10", "192.0.2.10", "192.0.2.10"]);
  });

  it("uses Qwik connection metadata when the Node socket is unavailable", () => {
    expect(
      trustedActivationClientAddress({ clientConn: { ip: "2001:DB8::1" } }),
    ).toBe("2001:db8::1");
  });

  it.each([undefined, "", "arbitrary-client-key", "192.0.2.1, 192.0.2.2"])(
    "uses a shared bucket for missing or invalid connection identity: %s",
    (ip) => {
      expect(trustedActivationClientAddress({ clientConn: { ip } })).toBe(
        "unknown",
      );
    },
  );
});
