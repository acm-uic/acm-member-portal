import { component$, Slot } from "@builder.io/qwik";
import type { RequestHandler } from "@builder.io/qwik-city";
import { requirePermission } from "~/lib/rbac/guards";

/**
 * Gate: authenticated + `admin.access` permission. requirePermission throws
 * 302 (unauthenticated) / 403 (no grant) before any loader runs, and stashes
 * the resolved permission set in sharedMap for downstream admin loaders.
 */
export const onRequest: RequestHandler = async (event) => {
	await requirePermission(event, "admin.access");
};

export default component$(() => {
	return <Slot />;
});
