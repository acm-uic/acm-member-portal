import type { RequestEventCommon } from "@builder.io/qwik-city";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/dashboard/load", () => ({ loadUserRoleKeys: vi.fn() }));
import { loadUserRoleKeys } from "~/lib/dashboard/load";
import { requirePortalStatusAccess } from "./portal-status-access";

function event(authenticated = true) {
  return {
    sharedMap: new Map(
      authenticated ? [["session", { user: { id: "user-1" } }]] : [],
    ),
    url: new URL("https://portal.test/dashboard/status"),
    redirect: vi.fn((status, location) => ({ status, location })),
    error: vi.fn((status, message) => ({ status, message })),
  } as unknown as RequestEventCommon;
}

describe("portal status access", () => {
  beforeEach(() => vi.mocked(loadUserRoleKeys).mockReset());
  it.each(["admin", "officer"])("allows %s", async (role) => {
    vi.mocked(loadUserRoleKeys).mockResolvedValue(["member", role]);
    expect(await requirePortalStatusAccess(event())).toEqual({
      user: { id: "user-1" },
    });
  });
  it.each([[], ["member"], ["moderator"], ["sig_leader"], ["alumni"]])(
    "denies other roles %j",
    async (...roles) => {
      vi.mocked(loadUserRoleKeys).mockResolvedValue(roles as string[]);
      await expect(requirePortalStatusAccess(event())).rejects.toMatchObject({
        status: 403,
      });
    },
  );
  it("redirects unauthenticated requests before resolving roles", async () => {
    await expect(requirePortalStatusAccess(event(false))).rejects.toMatchObject(
      { status: 302, location: "/login?next=%2Fdashboard%2Fstatus" },
    );
    expect(loadUserRoleKeys).not.toHaveBeenCalled();
  });
});
