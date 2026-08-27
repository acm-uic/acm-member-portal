import { describe, expect, it } from "vitest";
import { parseSignupDraft } from "./signup-draft";

describe("parseSignupDraft", () => {
  it("round-trips posted field values including multiselect", () => {
    const raw = JSON.stringify({
      first_name: "Ada",
      sig_interest: ["sig-webdev", "sig-ai"],
      internships: "2",
    });
    expect(parseSignupDraft(raw)).toEqual({
      first_name: "Ada",
      sig_interest: ["sig-webdev", "sig-ai"],
      internships: "2",
    });
  });

  it("stringifies booleans from checkbox fields", () => {
    expect(parseSignupDraft(JSON.stringify({ agreed: true }))).toEqual({
      agreed: "true",
    });
  });

  it("rejects missing, invalid, or empty payloads", () => {
    expect(parseSignupDraft(null)).toBeNull();
    expect(parseSignupDraft("not-json")).toBeNull();
    expect(parseSignupDraft("[]")).toBeNull();
    expect(parseSignupDraft("{}")).toBeNull();
  });
});
