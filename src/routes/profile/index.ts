import type { RequestHandler } from "@builder.io/qwik-city";

export const onRequest: RequestHandler = ({ redirect, url }) => {
	throw redirect(308, `/dashboard/profile${url.search}`);
};
