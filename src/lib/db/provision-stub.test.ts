import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration: claim → stub AD → mail file, without Windows API or SMTP.
 * Uses a temporary PGlite via the app db module.
 */
describe("provisioning stub drain", () => {
	let dataDir: string;
	let mailDir: string;

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), "portal-pglite-"));
		mailDir = mkdtempSync(join(tmpdir(), "portal-mail-"));
		process.env.PGLITE_DATA_DIR = dataDir;
		process.env.MAIL_DIR = mailDir;
		delete process.env.DATABASE_URL;
		delete process.env.SMTP_HOST;
		delete process.env.WINDOWS_API_URL;
		process.env.NODE_ENV = "development";
		process.env.BETTER_AUTH_SECRET = "test-secret-at-least-32-characters!!";
		process.env.BETTER_AUTH_URL = "http://localhost:5173";
		// Reset module singletons between tests
		vi.resetModules();
		delete (globalThis as { __portalDb?: unknown }).__portalDb;
		delete (globalThis as { __pgliteClient?: unknown }).__pgliteClient;
		delete (globalThis as { __portalEmbedded?: unknown }).__portalEmbedded;
		delete (globalThis as { __portalDevBootstrapped?: unknown })
			.__portalDevBootstrapped;
		delete (globalThis as { __portalDrainTimer?: unknown }).__portalDrainTimer;
	});

	afterEach(async () => {
		const client = (globalThis as { __pgliteClient?: { close: () => Promise<void> } })
			.__pgliteClient;
		if (client) {
			await client.close().catch(() => {});
		}
		const timer = (globalThis as { __portalDrainTimer?: ReturnType<typeof setInterval> })
			.__portalDrainTimer;
		if (timer) clearInterval(timer);

		rmSync(dataDir, { recursive: true, force: true });
		rmSync(mailDir, { recursive: true, force: true });
		delete (globalThis as { __portalDb?: unknown }).__portalDb;
		delete (globalThis as { __pgliteClient?: unknown }).__pgliteClient;
		delete (globalThis as { __portalEmbedded?: unknown }).__portalEmbedded;
		delete (globalThis as { __portalDevBootstrapped?: unknown })
			.__portalDevBootstrapped;
		delete (globalThis as { __portalDrainTimer?: unknown }).__portalDrainTimer;
	});

	it("drainOnce stubs AD and writes credential mail", async () => {
		const { db } = await import("./index");
		const { formSchemas, signupSubmissions, provisioningEvents } =
			await import("./schema");
		const { eq } = await import("drizzle-orm");
		const { drainOnce } = await import("../../worker/provisioning");

		const [schema] = await db
			.select()
			.from(formSchemas)
			.where(eq(formSchemas.formKey, "signup"))
			.limit(1);
		expect(schema).toBeTruthy();

		const [submission] = await db
			.insert(signupSubmissions)
			.values({
				schemaVersionId: schema!.id,
				displayName: "Test User",
				netid: "tuser",
				uin: "123456789",
				email: "tuser@example.com",
				answers: { major: "CS" },
				status: "approved",
			})
			.returning();

		const eventId = crypto.randomUUID();
		await db.insert(provisioningEvents).values({
			id: eventId,
			submissionId: submission!.id,
			payload: {
				netid: "tuser",
				displayName: "Test User",
				email: "tuser@example.com",
				uin: "123456789",
				eventId,
			},
			status: "pending",
			nextAttemptAt: new Date(0),
		});

		const didWork = await drainOnce();
		expect(didWork).toBe(true);

		const [event] = await db
			.select()
			.from(provisioningEvents)
			.where(eq(provisioningEvents.id, eventId));
		expect(event?.status).toBe("provisioned");

		const files = readdirSync(mailDir);
		expect(files.length).toBeGreaterThanOrEqual(1);
		const body = readFileSync(join(mailDir, files[0]!), "utf8");
		expect(body).toContain("tuser@example.com");
		expect(body).toContain("One-time password:");
	});
});
