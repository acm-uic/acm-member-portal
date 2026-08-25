import type { RequestHandler } from "@builder.io/qwik-city";
import { auth } from "~/lib/auth";
import { ensureDevBootstrap } from "~/lib/dev/bootstrap";
import type { PortalSession } from "~/lib/types";

/**
 * Auth middleware: resolves the session once per request into sharedMap
 * (server-only — never serialized to the client), mapped onto the
 * PortalSession contract from src/lib/types.ts. Route-group layouts and
 * loaders read it from there. Cookie-cache in auth.ts bounds DB cost.
 */
export const onRequest: RequestHandler = async ({
	request,
	sharedMap,
	next,
}) => {
	await ensureDevBootstrap();

	const s = await auth.api.getSession({ headers: request.headers });
	const session: PortalSession | null = s
		? {
				user: {
					id: s.user.id,
					name: s.user.name,
					email: s.user.email,
					netid: (s.user as { netid?: string | null }).netid ?? null,
					entraOid: (s.user as { entraOid?: string | null }).entraOid ?? null,
				},
				sessionId: s.session.id,
				expiresAt: s.session.expiresAt,
			}
		: null;
	sharedMap.set("session", session);
	await next();
};
