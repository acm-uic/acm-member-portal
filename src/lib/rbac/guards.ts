import type { RequestEventCommon } from "@builder.io/qwik-city";
import type { PortalSession } from "~/lib/types";
import { resolvePermissions } from "./index";
import type { PermissionKey } from "./permissions";

/**
 * Composable guard for layouts, loaders, and actions.
 * Throws 302 (unauthenticated) or 403 (missing permission) BEFORE any loader
 * body runs — loader returns are serialized to the client, so authorization
 * must happen first. Resolved permissions are stashed in sharedMap so
 * downstream loaders re-use them without a second DB round-trip.
 *
 * Accepts `RequestEventCommon` (parent of `RequestEvent`, `RequestEventLoader`,
 * `RequestEventAction`) so loaders and actions can pass their narrower event
 * types without type-cast friction.
 */
export async function requirePermission(
	event: RequestEventCommon,
	key: PermissionKey,
): Promise<PortalSession> {
	const session = event.sharedMap.get("session") as PortalSession | null;
	if (!session?.user) {
		throw event.redirect(
			302,
			`/login?next=${encodeURIComponent(event.url.pathname)}`,
		);
	}
	const permissions = await resolvePermissions(session.user.id);
	if (!permissions.has(key)) {
		throw event.error(403, "Forbidden");
	}
	event.sharedMap.set("permissions", permissions);
	return session;
}

/** Permissions resolved by an upstream guard this request, else resolve now. */
export async function getPermissions(
	event: RequestEventCommon,
): Promise<Set<PermissionKey>> {
	const cached = event.sharedMap.get("permissions") as
		| Set<PermissionKey>
		| undefined;
	if (cached) return cached;
	const session = event.sharedMap.get("session") as PortalSession | null;
	if (!session?.user) return new Set();
	const permissions = await resolvePermissions(session.user.id);
	event.sharedMap.set("permissions", permissions);
	return permissions;
}
