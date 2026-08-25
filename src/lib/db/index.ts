import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { isEmbeddedDb, pgliteDataDir } from "./mode";

const { Pool } = pg;

/** Public DB type — both drivers satisfy this query surface at runtime. */
export type PortalDb = NodePgDatabase<typeof schema>;

declare global {
	var __portalPool: pg.Pool | undefined;
	var __portalDb: PortalDb | undefined;
	var __portalEmbedded: boolean | undefined;
	var __pgliteClient: import("@electric-sql/pglite").PGlite | undefined;
}

/**
 * Minimal pool surface for RBAC LISTEN. On PGlite, connect() rejects so the
 * RBAC cache falls back to its 5s TTL.
 */
export type PortalPool = {
	connect: () => Promise<{
		query: (text: string) => Promise<unknown>;
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		release: () => void;
	}>;
};

function stubPool(): PortalPool {
	return {
		connect: async () => {
			throw new Error("LISTEN unavailable (embedded PGlite)");
		},
	};
}

async function initEmbedded(): Promise<{ db: PortalDb; pool: PortalPool }> {
	const { PGlite } = await import("@electric-sql/pglite");
	const { drizzle } = await import("drizzle-orm/pglite");
	const { mkdirSync } = await import("node:fs");
	const { applySqlMigrations } = await import("./migrate");

	const dataDir = pgliteDataDir();
	mkdirSync(dataDir, { recursive: true });

	const client = globalThis.__pgliteClient ?? new PGlite(dataDir);
	globalThis.__pgliteClient = client;

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

	return {
		db: drizzle(client, { schema }) as unknown as PortalDb,
		pool: stubPool(),
	};
}

function initPg(): { db: PortalDb; pool: PortalPool } {
	if (!process.env.DATABASE_URL && process.env.NODE_ENV === "production") {
		throw new Error("DATABASE_URL is required in production");
	}

	const poolInst =
		globalThis.__portalPool ??
		new Pool({
			connectionString: process.env.DATABASE_URL,
			max: 10,
			idleTimeoutMillis: 30_000,
		});

	if (process.env.NODE_ENV !== "production") {
		globalThis.__portalPool = poolInst;
	}

	return {
		db: drizzlePg(poolInst, { schema }),
		pool: poolInst as unknown as PortalPool,
	};
}

const embedded = isEmbeddedDb();

const boot =
	globalThis.__portalDb && globalThis.__portalEmbedded === embedded
		? {
				db: globalThis.__portalDb,
				pool: embedded
					? stubPool()
					: (globalThis.__portalPool as unknown as PortalPool),
			}
		: embedded
			? await initEmbedded()
			: initPg();

globalThis.__portalDb = boot.db;
globalThis.__portalEmbedded = embedded;

export const db = boot.db;
export const pool = boot.pool;

/** No-op after module load (kept for call sites that await boot explicitly). */
export async function ensureDbReady(): Promise<void> {
	/* module TLA already completed */
}
