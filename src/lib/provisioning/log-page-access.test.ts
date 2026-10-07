import type { RequestEventCommon } from "@builder.io/qwik-city";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ guard: vi.fn(), select: vi.fn() }));
vi.mock("../db", () => ({ db: { select: mocks.select } }));
vi.mock("../rbac/guards", () => ({ requirePermission: mocks.guard }));
import { loadProvisioningPage, requireProvisioningLogAccess } from "./log-page";
const event = {
  url: new URL("https://portal.example/dashboard/admin/provisioning/"),
} as RequestEventCommon;

describe("provisioning log access", () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(["admin.access", "signups.review"])(
    "rejects missing %s before querying diagnostics",
    async (missing) => {
      mocks.guard.mockImplementation(async (_event, permission) => {
        if (permission === missing) throw new Error("Forbidden");
      });
      await expect(loadProvisioningPage(event)).rejects.toThrow("Forbidden");
      expect(mocks.select).not.toHaveBeenCalled();
    },
  );
  it("requires both admin access and signup review", async () => {
    await requireProvisioningLogAccess(event);
    expect(mocks.guard.mock.calls.map((call) => call[1])).toEqual([
      "admin.access",
      "signups.review",
    ]);
  });
});
