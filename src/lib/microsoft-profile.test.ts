import { describe, expect, it } from "vitest";
import { mapMicrosoftProfileToUser } from "./microsoft-profile";

describe("Microsoft profile mapping", () => {
  it("stores the NetID without changing the email or Microsoft identity", () => {
    expect(
      mapMicrosoftProfileToUser({
        preferred_username: "clee231@acmuic.org",
        upn: "other@acmuic.org",
        email: "chase@example.com",
        oid: "entra-object-id",
        name: "Chase Lee",
      }),
    ).toEqual({
      netid: "clee231",
      email: "chase@example.com",
      entraOid: "entra-object-id",
      displayName: "Chase Lee",
    });
  });

  it("keeps the full preferred username as the email fallback", () => {
    expect(
      mapMicrosoftProfileToUser({ preferred_username: "clee231@acmuic.org" }),
    ).toMatchObject({ netid: "clee231", email: "clee231@acmuic.org" });
  });

  it("extracts the NetID from the UPN when preferred_username is absent", () => {
    expect(mapMicrosoftProfileToUser({ upn: "clee231@acmuic.org" }).netid).toBe(
      "clee231",
    );
  });

  it.each(["clee231", " clee231@acmuic.org "])(
    "accepts the identifier %j",
    (preferred_username) => {
      expect(mapMicrosoftProfileToUser({ preferred_username }).netid).toBe(
        "clee231",
      );
    },
  );

  it.each([undefined, "", "@acmuic.org"])(
    "leaves NetID unset for an empty identifier %j",
    (preferred_username) => {
      expect(mapMicrosoftProfileToUser({ preferred_username }).netid).toBeNull();
    },
  );
});
