import type { RequestHandler } from "@builder.io/qwik-city";
import { z } from "zod";
import { getPermissions } from "~/lib/rbac/guards";
import {
  confirmManualDelivery,
  ManualDeliveryError,
  revealManualCredentials,
} from "~/lib/provisioning/manual-delivery";
import type { PortalSession } from "~/lib/types";

const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reveal"), id: z.uuid() }),
  z.object({ action: z.literal("confirm"), id: z.uuid(), token: z.uuid() }),
]);

export const onPost: RequestHandler = async (event) => {
  const { request, headers, sharedMap, url, json } = event;
  headers.set("Cache-Control", "no-store");
  const session = sharedMap.get("session") as PortalSession | null;
  if (!session?.user) {
    json(401, { ok: false, error: "Sign in to manage signup credentials." });
    return;
  }
  const perms = await getPermissions(event);
  if (!perms.has("signups.review") || !perms.has("signups.approve")) {
    json(403, {
      ok: false,
      error: "You do not have permission to manage signup credentials.",
    });
    return;
  }
  if (request.headers.get("origin") !== (process.env.ORIGIN || url.origin)) {
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
  let data;
  try {
    data = input.safeParse(await request.json());
  } catch {
    /* Invalid JSON. */
  }
  if (!data?.success) {
    json(400, { ok: false, error: "Invalid credential request." });
    return;
  }
  try {
    if (data.data.action === "reveal") {
      json(200, await revealManualCredentials(data.data.id, session.user.id));
    } else if (
      await confirmManualDelivery(
        data.data.id,
        data.data.token,
        session.user.id,
      )
    ) {
      json(200, { ok: true });
    } else {
      json(409, {
        ok: false,
        error:
          "These credentials were replaced or already acknowledged. Refresh status before continuing.",
      });
    }
  } catch (error) {
    // Unexpected errors must not echo any credential values from downstream code.
    json(error instanceof ManualDeliveryError ? error.status : 503, {
      ok: false,
      error:
        error instanceof ManualDeliveryError
          ? error.message
          : "Credential delivery is unavailable. Try again.",
    });
  }
};
