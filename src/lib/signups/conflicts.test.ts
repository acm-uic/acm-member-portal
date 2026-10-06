import { describe, expect, it } from "vitest";
import { pendingSignupConflictErrors } from "./conflicts";

const constraints = [
  ["signup_submissions_pending_username_key", "username"],
] as const;

describe("pending signup conflict errors", () => {
  it.each(constraints)("maps the %s constraint to %s", (constraint, field) => {
    const error = { code: "23505", constraint, detail: "Private query data" };
    const errors = pendingSignupConflictErrors(error);
    expect(Object.keys(errors!)).toEqual([field]);
    expect(errors![field]).toContain("already pending review");
    expect(JSON.stringify(errors)).not.toContain("Private query data");
  });

  it.each(constraints)("unwraps Drizzle errors for %s", (constraint, field) => {
    const error = new Error("Query failed", {
      cause: new Error("Wrapper", { cause: { code: "23505", constraint } }),
    });
    expect(pendingSignupConflictErrors(error)).toHaveProperty(field);
  });

  it.each([
    null,
    "23505",
    new Error("Database unavailable"),
    { code: "23505", constraint: "signup_submissions_pending_discord_id_key" },
    { code: "23505", constraint: "user_username_unique" },
    { code: "23505", constraint: "signup_submissions_pending_netid_key" },
    { code: "23503", constraint: "signup_submissions_pending_netid_key" },
  ])("does not translate an unrelated failure: %j", (error) => {
    expect(pendingSignupConflictErrors(error)).toBeNull();
  });

  it("stops at a circular cause chain", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(pendingSignupConflictErrors(error)).toBeNull();
  });
});
