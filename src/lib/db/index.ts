import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

declare global {
	// Singleton across dev-server hot reloads
	var __portalPool: pg.Pool | undefined;
}

export const pool =
	globalThis.__portalPool ??
	new Pool({
		connectionString: process.env.DATABASE_URL,
		max: 10,
		idleTimeoutMillis: 30_000,
	});

if (process.env.NODE_ENV !== "production") globalThis.__portalPool = pool;

export const db = drizzle(pool, { schema });
