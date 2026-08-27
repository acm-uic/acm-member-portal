import type { RequestHandler } from "@builder.io/qwik-city";

export const onRequest: RequestHandler = ({ params, redirect, url }) => {
	const rest = String(params.slug ?? "").replace(/^\/+|\/+$/g, "");
	const dest = rest
		? `/dashboard/admin/${rest}`
		: "/dashboard/admin/signups";
	throw redirect(308, dest + url.search);
};
