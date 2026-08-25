/**
 * Minimal expand-only migration runner (init container / local dev).
 * With DATABASE_URL: connects via pg and applies drizzle/*.sql.
 * Without DATABASE_URL (non-production): targets the same .data/pglite store
 * used by `vite --mode ssr` embedded mode.
 *
 * Run: node scripts/migrate.ts  (Node 24+ type-stripping)
 */
import { mkdirSync } from "node:fs";
import pg from "pg";
import { applySqlMigrations } from "../src/lib/db/migrate.ts";
import { isEmbeddedDb, pgliteDataDir } from "../src/lib/db/mode.ts";

if (isEmbeddedDb()) {
	const { PGlite } = await import("@electric-sql/pglite");
	const dataDir = pgliteDataDir();
	mkdirSync(dataDir, { recursive: true });
	const client = new PGlite(dataDir);

	const query = async (text: string, params?: unknown[]) => {
		if (params?.length) {
			const result = await client.query(text, params);
			return { rows: (result.rows ?? []) as Record<string, unknown>[] };
		}
		const results = await client.exec(text);
		const last = results[results.length - 1] as
			| { rows?: Record<string, unknown>[] }
			| undefined;
		return { rows: last?.rows ?? [] };
	};

	await applySqlMigrations(query, { useAdvisoryLock: false });
	await client.close();
} else {
	if (!process.env.DATABASE_URL) {
		console.error("DATABASE_URL is required (or omit it for PGlite local mode)");
		process.exit(1);
	}

	const { Client } = pg;
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();

	try {
		await applySqlMigrations((text, params) =>
			client.query(text, params as never).then((r) => ({
				rows: r.rows as Record<string, unknown>[],
			})),
		);
	} finally {
		await client.end();
	}
}
