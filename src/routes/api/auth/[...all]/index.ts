import type { RequestHandler } from "@builder.io/qwik-city";
import { auth } from "~/lib/auth";

/**
 * Better Auth catch-all. The handler is Fetch-API native; the FULL Response
 * must be passed to send() — forwarding only status/text drops Set-Cookie
 * and breaks the OAuth callback (known bug in older example repos).
 */
export const onRequest: RequestHandler = async (event) => {
	event.send(await auth.handler(event.request));
};
