import { nodeServerAdapter } from "@builder.io/qwik-city/adapters/node-server/vite";
import { extendConfig } from "@builder.io/qwik-city/vite";
import baseConfig from "../../vite.config";

export default extendConfig(baseConfig, () => ({
	build: {
		ssr: true,
		rollupOptions: { input: ["src/entry.fastify.tsx", "@qwik-city-plan"] },
	},
	plugins: [
		// Auth middleware imports the DB; SSG would require DATABASE_URL at build time.
		nodeServerAdapter({ name: "fastify", ssg: null }),
	],
}));
