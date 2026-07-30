import { component$, Slot } from "@builder.io/qwik";
import type { RequestHandler } from "@builder.io/qwik-city";
import type { PortalSession } from "~/lib/types";

/** Gate: any authenticated user. Phase 4 replaces this with requirePermission(admin.access). */
export const onRequest: RequestHandler = ({ sharedMap, redirect, url }) => {
	const session = sharedMap.get("session") as PortalSession | null;
	if (!session?.user) {
		throw redirect(302, `/login?next=${encodeURIComponent(url.pathname)}`);
	}
};

export default component$(() => {
	return <Slot />;
});
