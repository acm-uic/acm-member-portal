/**
 * Minimal expand-only migration runner (init container / local dev).
 * drizzle-kit's migrator requires meta journals and takes no DB-level lock;
 * this runner tracks applied files and holds a pg advisory lock so concurrent
 * replicas cannot race (rolling-deploy safe). Applies drizzle/*.sql in lexical
 * order, once each. Run: node scripts/migrate.ts  (Node 24+ type-stripping;
 * the only external import is pg).
 */
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;
const MIGRATIONS_DIR = new URL("../drizzle/", import.meta.url);
const LOCK_ID = 727_001;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

await client.query(`CREATE TABLE IF NOT EXISTS "_migrations" (
  "name" text PRIMARY KEY,
  "applied_at" timestamptz NOT NULL DEFAULT now()
)`);

await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);
try {
	const { rows } = await client.query<{ name: string }>(
		'SELECT "name" FROM "_migrations"',
	);
	const applied = new Set(rows.map((r) => r.name));
	const files = readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const file of files) {
		if (applied.has(file)) continue;
		console.log(`Applying ${file}…`);
		await client.query("BEGIN");
		try {
			await client.query(readFileSync(new URL(file, MIGRATIONS_DIR), "utf8"));
			await client.query('INSERT INTO "_migrations" ("name") VALUES ($1)', [
				file,
			]);
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	}
	console.log("Migrations up to date.");
} finally {
	await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
	await client.end();
}
