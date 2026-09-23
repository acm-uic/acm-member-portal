import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ensureDevBootstrap officer login", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "portal-pglite-"));
		process.env.PGLITE_DATA_DIR = dataDir;
		delete process.env.DATABASE_URL;
		process.env.NODE_ENV = "development";
		process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters!!";
		process.env.BETTER_AUTH_URL = "http://localhost:5173";
		vi.resetModules();
		delete (globalThis as { __portalDb?: unknown }).__portalDb;
		delete (globalThis as { __pgliteClient?: unknown }).__pgliteClient;
		delete (globalThis as { __pgliteBoot?: unknown }).__pgliteBoot;
		delete (globalThis as { __pgliteShutdownHooked?: unknown })
			.__pgliteShutdownHooked;
		delete (globalThis as { __portalEmbedded?: unknown }).__portalEmbedded;
		delete (globalThis as { __portalDevBootstrapped?: unknown })
			.__portalDevBootstrapped;
	});

	afterEach(async () => {
		const client = (
			globalThis as { __pgliteClient?: { close: () => Promise<void> } }
		).__pgliteClient;
		if (client) {
			await client.close().catch(() => {});
		}
		rmSync(dataDir, { recursive: true, force: true });
		delete (globalThis as { __portalDb?: unknown }).__portalDb;
		delete (globalThis as { __pgliteClient?: unknown }).__pgliteClient;
		delete (globalThis as { __pgliteBoot?: unknown }).__pgliteBoot;
		delete (globalThis as { __pgliteShutdownHooked?: unknown })
			.__pgliteShutdownHooked;
		delete (globalThis as { __portalEmbedded?: unknown }).__portalEmbedded;
		delete (globalThis as { __portalDevBootstrapped?: unknown })
			.__portalDevBootstrapped;
	});

	it("seeds officer@local.test so email/password sign-in works", async () => {
		const { ensureDevBootstrap } = await import("./bootstrap");
		await ensureDevBootstrap();

		const { auth } = await import("~/lib/auth");
		const result = await auth.api.signInEmail({
			body: {
				email: "officer@local.test",
				password: "local-dev",
			},
		});
		expect(result.user.email).toBe("officer@local.test");

		const { resolveDevLoginEmail } = await import("./login-identifier");
		expect(await resolveDevLoginEmail("officer")).toBe("officer@local.test");
	});

	it("replaces an officer user that has no credential account", async () => {
		const { db } = await import("~/lib/db");
		const { user } = await import("~/lib/db/schema");
		await db.insert(user).values({
			id: "u-broken-officer",
			name: "Local Officer",
			email: "officer@local.test",
			emailVerified: false,
			username: "officer",
		});

		const { ensureDevBootstrap } = await import("./bootstrap");
		await ensureDevBootstrap();

		const { auth } = await import("~/lib/auth");
		const result = await auth.api.signInEmail({
			body: {
				email: "officer@local.test",
				password: "local-dev",
			},
		});
		expect(result.user.email).toBe("officer@local.test");
		expect(result.user.id).not.toBe("u-broken-officer");
	});
});
