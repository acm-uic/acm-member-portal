import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("bootstrapUser Discord copy", () => {
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

  it("copies an approved signup Discord snowflake onto the user and account row", async () => {
    const { db } = await import("~/lib/db");
    const { account, formSchemas, signupSubmissions, user } =
      await import("~/lib/db/schema");
    const { bootstrapUser } = await import("./auth-bootstrap");
    const { eq } = await import("drizzle-orm");

    const [schema] = await db.select().from(formSchemas).limit(1);
    expect(schema).toBeTruthy();

    await db.insert(signupSubmissions).values({
      schemaVersionId: schema!.id,
      firstName: "Ada",
      lastName: "Lovelace",
      netid: "alove",
      username: "ada",
      email: "ada@example.com",
      answers: { major: "CS" },
      status: "approved",
      discordId: "555",
      discordUsername: "ada",
      discordInGuild: false,
    });

    await db.insert(user).values({
      id: "u-ada",
      name: "Ada Lovelace",
      email: "ada@local.test",
      emailVerified: false,
      netid: "alove",
    });

    await bootstrapUser({
      id: "u-ada",
      email: "ada@local.test",
      netid: "alove",
      displayName: "Ada Lovelace",
    });

    const [row] = await db.select().from(user).where(eq(user.id, "u-ada"));
    expect(row?.discordId).toBe("555");
    expect(row?.discordUsername).toBe("ada");
    expect(row?.username).toBe("ada");

    const accounts = await db
      .select()
      .from(account)
      .where(eq(account.userId, "u-ada"));
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: "discord",
          accountId: "555",
        }),
      ]),
    );
  });

  it("does not copy a snowflake already owned by another member", async () => {
    const { db } = await import("~/lib/db");
    const { account, formSchemas, signupSubmissions, user } =
      await import("~/lib/db/schema");
    const { bootstrapUser } = await import("./auth-bootstrap");
    const { eq } = await import("drizzle-orm");

    const [schema] = await db.select().from(formSchemas).limit(1);

    await db.insert(user).values({
      id: "u-other",
      name: "Other",
      email: "other@local.test",
      emailVerified: false,
      discordId: "555",
      discordUsername: "taken",
    });

    await db.insert(signupSubmissions).values({
      schemaVersionId: schema!.id,
      firstName: "Ada",
      lastName: "Lovelace",
      netid: "alove",
      username: "ada",
      email: "ada@example.com",
      answers: {},
      status: "approved",
      discordId: "555",
      discordUsername: "ada",
    });

    await db.insert(user).values({
      id: "u-ada",
      name: "Ada Lovelace",
      email: "ada@local.test",
      emailVerified: false,
      netid: "alove",
    });

    await bootstrapUser({
      id: "u-ada",
      email: "ada@local.test",
      netid: "alove",
      displayName: "Ada Lovelace",
    });

    const [row] = await db.select().from(user).where(eq(user.id, "u-ada"));
    expect(row?.discordId).toBeNull();
    const accounts = await db
      .select()
      .from(account)
      .where(eq(account.userId, "u-ada"));
    expect(accounts.filter((a) => a.providerId === "discord")).toHaveLength(0);
  });
});
