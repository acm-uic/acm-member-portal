import type { RequestEventCommon } from "@builder.io/qwik-city";
import type { PortalSession } from "~/lib/types";
import { loadUserRoleKeys } from "~/lib/dashboard/load";

/** Status diagnostics are restricted to these roles, even with custom grants. */
export async function requirePortalStatusAccess(
  event: RequestEventCommon,
): Promise<PortalSession> {
  const session = event.sharedMap.get("session") as PortalSession | null;
  if (!session?.user) {
    throw event.redirect(
      302,
      `/login?next=${encodeURIComponent(event.url.pathname)}`,
    );
  }
  const roles = await loadUserRoleKeys(session.user.id);
  if (!roles.some((role) => role === "admin" || role === "officer")) {
    throw event.error(403, "Forbidden");
  }
  return session;
}
