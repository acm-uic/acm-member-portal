import type { RequestHandler } from "@builder.io/qwik-city";
import { db } from "~/lib/db";
import { handleActivationRequest } from "~/lib/activation-http";
import { trustedActivationClientAddress } from "~/lib/activation-client-address";
import { activateAccount } from "~/lib/provisioning/activate-account";

export const onPost: RequestHandler = async (event) => {
  event.headers.set("Cache-Control", "no-store");
  const result = await handleActivationRequest(
    event.request,
    process.env.ORIGIN || event.url.origin,
    trustedActivationClientAddress(event),
    (input, address) => activateAccount(db, input, address),
  );
  if (result.status === 429) event.headers.set("Retry-After", "900");
  const { status, ...body } = result;
  event.json(status, body);
};
