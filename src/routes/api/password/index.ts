import type { RequestHandler } from "@builder.io/qwik-city";
import { eq } from "drizzle-orm";
import { db } from "~/lib/db";
import { user } from "~/lib/db/schema";
import { changeAdPassword } from "~/lib/provisioning/change-password";
import type { PortalSession } from "~/lib/types";

export const onPost: RequestHandler = async ({
  request,
  sharedMap,
  url,
  headers,
  json,
}) => {
  headers.set("Cache-Control", "no-store");
  const session = sharedMap.get("session") as PortalSession | null;
  if (!session?.user) {
    json(401, { ok: false, error: "Sign in to change your password." });
    return;
  }
  // Require a same-origin JSON request, including when invoked outside the UI.
  const origin = process.env.ORIGIN || url.origin;
  if (request.headers.get("origin") !== origin) {
    json(403, { ok: false, error: "Reload the page and try again." });
    return;
  }
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  ) {
    json(415, { ok: false, error: "Expected a JSON request." });
    return;
  }
  let data: unknown;
  try {
    data = await request.json();
  } catch {
    json(400, { ok: false, error: "Invalid password change request." });
    return;
  }
  if (
    !data ||
    typeof data !== "object" ||
    !("currentPassword" in data) ||
    typeof data.currentPassword !== "string" ||
    !data.currentPassword ||
    !("newPassword" in data) ||
    typeof data.newPassword !== "string" ||
    !data.newPassword ||
    !("confirmPassword" in data) ||
    data.confirmPassword !== data.newPassword
  ) {
    json(400, {
      ok: false,
      error: "Enter your current password and matching new passwords.",
    });
    return;
  }
  if (data.currentPassword === data.newPassword) {
    json(400, {
      ok: false,
      error: "Choose a new password that differs from your current password.",
    });
    return;
  }
  // Read the current account name from the DB, not a cached session or submitted field.
  const [member] = await db
    .select({ username: user.username, netid: user.netid })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  const sam = member?.username || member?.netid;
  if (!sam) {
    json(400, {
      ok: false,
      error:
        "Your account has no Active Directory username. Contact ACM support.",
    });
    return;
  }
  const result = await changeAdPassword(
    sam,
    data.currentPassword,
    data.newPassword,
  );
  if (result.ok) {
    json(200, { ok: true });
    return;
  }
  if (result.status === 429) {
    headers.set("Retry-After", String(result.retryAfter));
  }
  json(result.status, { ok: false, error: result.error });
};
