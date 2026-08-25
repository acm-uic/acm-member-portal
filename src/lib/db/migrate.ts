/**
 * Shared expand-only SQL migrator used by scripts/migrate.ts (pg Client) and
 * the PGlite boot path. Tracks applied files in `_migrations`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type SqlQuery = (
	text: string,
	params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

const DEFAULT_MIGRATIONS_DIR = new URL("../../../drizzle/", import.meta.url);
const LOCK_ID = 727_001;

export function migrationsDirUrl(override?: string | URL): URL {
	if (!override) return DEFAULT_MIGRATIONS_DIR;
	if (typeof override === "string") {
		return new URL(
			override.endsWith("/") ? override : `${override}/`,
			"file:///",
		);
	}
	return override;
}

/**
 * Apply drizzle/*.sql in lexical order, once each.
 * @param useAdvisoryLock — false for single-process PGlite
 */
export async function applySqlMigrations(
	query: SqlQuery,
	opts: { useAdvisoryLock?: boolean; migrationsDir?: string | URL } = {},
): Promise<void> {
	const useLock = opts.useAdvisoryLock ?? true;
	const dir = migrationsDirUrl(opts.migrationsDir);
	const dirPath = fileURLToPath(dir);

	await query(`CREATE TABLE IF NOT EXISTS "_migrations" (
  "name" text PRIMARY KEY,
  "applied_at" timestamptz NOT NULL DEFAULT now()
)`);

	if (useLock) {
		await query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
	}

	try {
		const { rows } = await query('SELECT "name" FROM "_migrations"');
		const applied = new Set(rows.map((r) => String(r.name)));
		const files = readdirSync(dirPath)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		for (const file of files) {
			if (applied.has(file)) continue;
			console.log(`Applying ${file}…`);
			await query("BEGIN");
			try {
				const sql = readFileSync(new URL(file, dir), "utf8");
				await query(sql);
				await query('INSERT INTO "_migrations" ("name") VALUES ($1)', [file]);
				await query("COMMIT");
			} catch (err) {
				await query("ROLLBACK");
				throw err;
			}
		}
		console.log("Migrations up to date.");
	} finally {
		if (useLock) {
			await query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
		}
	}
}
