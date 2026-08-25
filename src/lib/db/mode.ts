/**
 * Local embedded Postgres (PGlite) when DATABASE_URL is unset and we are not
 * in production. Production always requires a real Postgres URL.
 */
export function isEmbeddedDb(): boolean {
	return !process.env.DATABASE_URL && process.env.NODE_ENV !== "production";
}

export function pgliteDataDir(): string {
	return process.env.PGLITE_DATA_DIR ?? ".data/pglite";
}

/** True when local email/password login is enabled (embedded DB or DEV_LOGIN=1). */
export function isDevLoginEnabled(): boolean {
	return isEmbeddedDb() || process.env.DEV_LOGIN === "1";
}
