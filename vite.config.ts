import { defineConfig, type Plugin } from "vite";
import { qwikVite } from "@builder.io/qwik/optimizer";
import { qwikCity } from "@builder.io/qwik-city/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Qwik's optimizer keeps DB/auth usage inside loaders/actions, but Vite still
 * walks those modules during the client build and chokes on node: builtins.
 * Mark them external for non-SSR resolves so the client build can finish;
 * those chunks are never loaded in the browser.
 */
const CLIENT_EXTERNALS = new Set([
	"pg",
	"pg-native",
	"fs",
	"path",
	"url",
	"crypto",
	"net",
	"tls",
	"dns",
	"stream",
	"events",
	"util",
	"os",
	"buffer",
	"string_decoder",
	"perf_hooks",
	"worker_threads",
	"child_process",
]);

function externalizeNodeBuiltinsForClient(): Plugin {
	return {
		name: "externalize-node-builtins-for-client",
		enforce: "pre",
		resolveId(id, _importer, options) {
			if (options?.ssr) return null;
			if (id.startsWith("node:") || CLIENT_EXTERNALS.has(id.split("/")[0]!)) {
				return { id, external: true };
			}
			return null;
		},
	};
}

export default defineConfig(() => ({
	plugins: [
		externalizeNodeBuiltinsForClient(),
		qwikCity(),
		qwikVite(),
		tsconfigPaths(),
		tailwindcss(),
	],
	server: { headers: { "Cache-Control": "public, max-age=0" } },
	preview: { headers: { "Cache-Control": "public, max-age=600" } },
	optimizeDeps: {
		exclude: ["@electric-sql/pglite"],
	},
	ssr: {
		external: ["@electric-sql/pglite", "pg", "pg-native"],
	},
	worker: {
		format: "es" as const,
	},
}));
