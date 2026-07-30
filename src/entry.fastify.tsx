import {
	type PlatformNode,
	createQwikCity,
} from "@builder.io/qwik-city/middleware/node";
import Fastify from "fastify";
import qwikCityPlan from "@qwik-city-plan";
import render from "./entry.ssr";

declare global {
	interface QwikCityPlatform extends PlatformNode {}
}

const { router, notFound, staticFile } = createQwikCity({
	render,
	qwikCityPlan,
});

const app = Fastify({ logger: true, trustProxy: true });

app.setNotFoundHandler((request, reply) => {
	staticFile(request.raw, reply.raw, () => {
		router(request.raw, reply.raw, (error: unknown) => {
			if (error) {
				app.log.error(error);
				if (!reply.sent) reply.code(500).send("Internal Server Error");
				return;
			}
			notFound(request.raw, reply.raw, () => {});
		});
	});
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).then(() => {
	app.log.info(`ACM member portal listening on 0.0.0.0:${port}`);
});
