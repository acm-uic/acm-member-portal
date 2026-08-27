import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("discordIdTaken", () => {
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

  async function load() {
    const { db } = await import("~/lib/db");
    const { formSchemas, signupSubmissions, user } =
      await import("~/lib/db/schema");
    const { discordIdTaken } = await import("./discord-link");
    return { db, formSchemas, signupSubmissions, user, discordIdTaken };
  }

  it("reports a snowflake already on another user", async () => {
    const { db, user, discordIdTaken } = await load();
    await db.insert(user).values({
      id: "u-1",
      name: "Ada",
      email: "ada@local.test",
      emailVerified: false,
      discordId: "111",
      discordUsername: "ada",
    });
    expect(await discordIdTaken(db, "111")).toBe("user");
    expect(await discordIdTaken(db, "111", "u-1")).toBeNull();
    expect(await discordIdTaken(db, "999")).toBeNull();
  });

  it("reports a snowflake on a pending signup, not a denied one", async () => {
    const { db, formSchemas, signupSubmissions, discordIdTaken } = await load();
    const [schema] = await db.select().from(formSchemas).limit(1);
    expect(schema).toBeTruthy();

    await db.insert(signupSubmissions).values({
      schemaVersionId: schema!.id,
      firstName: "Ada",
      lastName: "Lovelace",
      netid: "alove1",
      username: "ada",
      email: "ada@example.com",
      answers: {},
      status: "denied",
      discordId: "222",
      discordUsername: "ada",
    });
    expect(await discordIdTaken(db, "222")).toBeNull();

    await db.insert(signupSubmissions).values({
      schemaVersionId: schema!.id,
      firstName: "Ada",
      lastName: "Lovelace",
      netid: "alove2",
      username: "ada2",
      email: "ada2@example.com",
      answers: {},
      status: "pending",
      discordId: "222",
      discordUsername: "ada",
    });
    expect(await discordIdTaken(db, "222")).toBe("pending");
  });
});
