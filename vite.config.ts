import { dirname, resolve as resolvePath } from "node:path";
import { type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { qwikVite } from "@builder.io/qwik/optimizer";
import { qwikCity } from "@builder.io/qwik-city/vite";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Qwik's optimizer keeps DB/auth usage inside loaders/actions, but Vite still
 * walks those modules during the client build. Externalizing node builtins is
 * not enough: SPA navigation loads the route module in the browser, which
 * still follows `import { db } from "~/lib/db"` and then falls back to a full
 * document load when `node:fs` / `pg` fail. Stub the DB entry on the client
 * so those imports resolve; loaders never run in the browser.
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

const CLIENT_DB_STUB_ID = "\0portal-db-client-stub";

function isPortalDbEntry(id: string) {
	const n = id.replace(/\\/g, "/");
	return (
		n === "~/lib/db" ||
		n === "~/lib/db/index.ts" ||
		n === "~/lib/db/index.js" ||
		/(?:^|\/)src\/lib\/db(?:\/index\.(?:ts|js))?$/.test(n)
	);
}

function dbClientStubSource() {
	return [
		"const serverOnly = new Proxy({}, { get() { throw new Error('db is server-only'); } });",
		"export const db = serverOnly;",
		"export const pool = serverOnly;",
		"export async function ensureDbReady() {}",
	].join("\n");
}

function externalizeNodeBuiltinsForClient(): Plugin {
	return {
		name: "externalize-node-builtins-for-client",
		enforce: "pre",
		applyToEnvironment(environment) {
			return environment.name !== "ssr";
		},
		resolveId(id, importer) {
			if (id === CLIENT_DB_STUB_ID || isPortalDbEntry(id)) {
				return CLIENT_DB_STUB_ID;
			}
			if (importer && (id.startsWith(".") || id.startsWith("/"))) {
				if (isPortalDbEntry(resolvePath(dirname(importer), id))) {
					return CLIENT_DB_STUB_ID;
				}
			}
			if (id.startsWith("node:") || CLIENT_EXTERNALS.has(id.split("/")[0]!)) {
				return { id, external: true };
			}
			return null;
		},
		load(id) {
			if (id === CLIENT_DB_STUB_ID || isPortalDbEntry(id)) {
				return dbClientStubSource();
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
	test: {
		// PGlite integration tests reset process-global module singletons.
		fileParallelism: false,
	},
}));
