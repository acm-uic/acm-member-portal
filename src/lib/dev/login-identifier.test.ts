import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("resolveDevLoginEmail", () => {
	let dataDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "portal-pglite-"));
		process.env.PGLITE_DATA_DIR = dataDir;
		delete process.env.DATABASE_URL;
		process.env.NODE_ENV = "development";
		vi.resetModules();
		delete (globalThis as { __portalDb?: unknown }).__portalDb;
		delete (globalThis as { __pgliteClient?: unknown }).__pgliteClient;
		delete (globalThis as { __pgliteBoot?: unknown }).__pgliteBoot;
		delete (globalThis as { __pgliteShutdownHooked?: unknown })
			.__pgliteShutdownHooked;
		delete (globalThis as { __portalEmbedded?: unknown }).__portalEmbedded;
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
	});

	async function seedUser() {
		const { db } = await import("~/lib/db");
		const { user } = await import("~/lib/db/schema");
		await db.insert(user).values({
			id: "u-ada",
			name: "Ada",
			email: "ada@local.test",
			emailVerified: false,
			username: "adaLovelace",
		});
		const { resolveDevLoginEmail } = await import("./login-identifier");
		return { resolveDevLoginEmail };
	}

	it("resolves a username to the account email", async () => {
		const { resolveDevLoginEmail } = await seedUser();
		expect(await resolveDevLoginEmail("adaLovelace")).toBe("ada@local.test");
	});

	it("resolves a username case-insensitively", async () => {
		const { resolveDevLoginEmail } = await seedUser();
		expect(await resolveDevLoginEmail("adalovelace")).toBe("ada@local.test");
	});

	it("resolves an email case-insensitively", async () => {
		const { resolveDevLoginEmail } = await seedUser();
		expect(await resolveDevLoginEmail("ADA@local.test")).toBe("ada@local.test");
	});

	it("passes unknown emails through for Better Auth to reject", async () => {
		const { resolveDevLoginEmail } = await seedUser();
		expect(await resolveDevLoginEmail("nobody@local.test")).toBe(
			"nobody@local.test",
		);
	});

	it("returns null for an unknown username", async () => {
		const { resolveDevLoginEmail } = await seedUser();
		expect(await resolveDevLoginEmail("missing")).toBeNull();
	});
});
