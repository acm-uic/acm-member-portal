import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { resolve as resolvePath } from "node:path";
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
	var __pgliteBoot: Promise<{ db: PortalDb; pool: PortalPool }> | undefined;
	var __pgliteShutdownHooked: boolean | undefined;
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

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function isWasmAbort(err: unknown): boolean {
	return (
		err instanceof Error &&
		(err.name === "RuntimeError" || err.message.includes("Aborted()"))
	);
}

/** Exclusive create of `.portal.lock`. Recovers a stale PID from a crashed process. */
function acquirePgliteLock(dataDir: string): string {
	const lockPath = `${dataDir}/.portal.lock`;
	mkdirSync(dataDir, { recursive: true });
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
			return lockPath;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			let holder = NaN;
			try {
				holder = Number(readFileSync(lockPath, "utf8").trim());
			} catch {
				continue;
			}
			if (
				Number.isInteger(holder) &&
				holder !== process.pid &&
				pidAlive(holder)
			) {
				throw new Error(
					`Embedded PGlite at ${dataDir} is already open in pid ${holder}. Stop the other portal process (another bun/npm run dev), or set PGLITE_DATA_DIR to a different path.`,
				);
			}
			try {
				unlinkSync(lockPath);
			} catch {
				/* raced with another starter */
			}
		}
	}
	throw new Error(`Could not lock PGlite data dir ${dataDir}`);
}

function hookPgliteShutdown(
	client: { close: () => Promise<void> },
	lockPath: string,
): void {
	if (globalThis.__pgliteShutdownHooked) return;
	globalThis.__pgliteShutdownHooked = true;
	const release = () => {
		try {
			if (existsSync(lockPath)) unlinkSync(lockPath);
		} catch {
			/* already released */
		}
		void client.close().catch(() => {});
	};
	process.once("exit", release);
	process.once("SIGINT", release);
	process.once("SIGTERM", release);
}

async function openPglite(
	PGlite: typeof import("@electric-sql/pglite").PGlite,
	dataDir: string,
): Promise<import("@electric-sql/pglite").PGlite> {
	try {
		return await PGlite.create(dataDir);
	} catch (err) {
		if (!isWasmAbort(err)) throw err;
		if (typeof process.exitCode === "number") process.exitCode = 0;
		console.warn(
			`[db] PGlite could not open ${dataDir} (corrupt after a crash). Recreating.`,
		);
		rmSync(dataDir, { recursive: true, force: true });
		acquirePgliteLock(dataDir);
		return await PGlite.create(dataDir);
	}
}

async function initEmbedded(): Promise<{ db: PortalDb; pool: PortalPool }> {
	if (globalThis.__pgliteClient && globalThis.__portalDb) {
		return { db: globalThis.__portalDb, pool: stubPool() };
	}

	const { PGlite } = await import("@electric-sql/pglite");
	const { drizzle } = await import("drizzle-orm/pglite");
	const { applySqlMigrations } = await import("./migrate");

	const useMemory = Boolean(process.env.VITEST) && !process.env.PGLITE_DATA_DIR;
	const dataDir = useMemory ? "memory://" : resolvePath(pgliteDataDir());
	const lockPath = useMemory ? null : acquirePgliteLock(dataDir);

	let client: import("@electric-sql/pglite").PGlite;
	try {
		client = useMemory
			? await PGlite.create("memory://")
			: await openPglite(PGlite, dataDir);

		globalThis.__pgliteClient = client;
		if (lockPath) hookPgliteShutdown(client, lockPath);

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
	} catch (err) {
		await globalThis.__pgliteClient?.close().catch(() => {});
		globalThis.__pgliteClient = undefined;
		if (lockPath) {
			try {
				if (existsSync(lockPath)) unlinkSync(lockPath);
			} catch {
				/* ignore */
			}
		}
		throw err;
	}
}

function bootEmbedded(): Promise<{ db: PortalDb; pool: PortalPool }> {
	if (!globalThis.__pgliteBoot) {
		globalThis.__pgliteBoot = initEmbedded().catch((err) => {
			globalThis.__pgliteBoot = undefined;
			throw err;
		});
	}
	return globalThis.__pgliteBoot;
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
			? await bootEmbedded()
			: initPg();

globalThis.__portalDb = boot.db;
globalThis.__portalEmbedded = embedded;

export const db = boot.db;
export const pool = boot.pool;

/** No-op after module load (kept for call sites that await boot explicitly). */
export async function ensureDbReady(): Promise<void> {
	/* module TLA already completed */
}
