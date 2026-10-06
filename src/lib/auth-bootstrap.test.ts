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
          issuer: "local:oauth:discord",
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
  it("matches each shared-NetID account by username and copies its own approved signup", async () => {
    const { db } = await import("~/lib/db");
    const {
      formSchemas,
      signupSubmissions,
      user,
      memberProfiles,
      provisioningEvents,
    } = await import("~/lib/db/schema");
    const { bootstrapUser } = await import("./auth-bootstrap");
    const { eq } = await import("drizzle-orm");
    const [schema] = await db.select().from(formSchemas).limit(1);
    for (const [index, username] of [
      "ada.primary",
      "ada.secondary",
    ].entries()) {
      const [submission] = await db
        .insert(signupSubmissions)
        .values({
          schemaVersionId: schema!.id,
          firstName: `Account ${index}`,
          lastName: "Lovelace",
          netid: "alove",
          username,
          email: `${username}@example.com`,
          answers: { major: `Major ${index}` },
          status: "approved",
          createdAt: new Date(2026, 0, index + 1),
        })
        .returning();
      await db.insert(provisioningEvents).values({
        submissionId: submission!.id,
        payload: {},
        status: "provisioned",
      });
      await db.insert(user).values({
        id: username,
        name: "Ada",
        email: `${username}@acmuic.org`,
        netid: username,
        username,
      });
    }
    // A more recent application must not replace an already-approved account's details.
    await db.insert(signupSubmissions).values({
      schemaVersionId: schema!.id,
      firstName: "Pending",
      lastName: "Account",
      netid: "alove",
      username: "ada.primary",
      email: "pending@example.com",
      answers: { major: "Pending" },
      status: "pending",
    });
    for (const [index, username] of [
      "ada.primary",
      "ada.secondary",
    ].entries()) {
      await bootstrapUser({
        id: username,
        email: `${username}@acmuic.org`,
        netid: username,
        username,
        displayName: "Ada",
      });
      const [account] = await db
        .select()
        .from(user)
        .where(eq(user.id, username));
      const [profile] = await db
        .select()
        .from(memberProfiles)
        .where(eq(memberProfiles.userId, username));
      expect(account).toMatchObject({
        netid: "alove",
        username,
        firstName: `Account ${index}`,
      });
      expect(profile).toMatchObject({
        answers: { major: `Major ${index}` },
        adProvisioningStatus: "provisioned",
      });
    }
  });

  it.each([undefined, "unmatched-account"])(
    "does not copy another account's details for a shared NetID without a matching username: %s",
    async (username) => {
      const { db } = await import("~/lib/db");
      const { formSchemas, signupSubmissions, user, memberProfiles } =
        await import("~/lib/db/schema");
      const { bootstrapUser } = await import("./auth-bootstrap");
      const { eq } = await import("drizzle-orm");
      const [schema] = await db.select().from(formSchemas).limit(1);
      for (const other of ["ada.primary", "ada.secondary"]) {
        await db.insert(signupSubmissions).values({
          schemaVersionId: schema!.id,
          firstName: other,
          lastName: "Lovelace",
          netid: "alove",
          username: other,
          email: `${other}@example.com`,
          answers: { private: other },
          status: "approved",
        });
      }
      await db.insert(user).values({
        id: "unmatched",
        name: "Unknown",
        email: "unknown@example.com",
        netid: "alove",
        username,
      });
      await bootstrapUser({
        id: "unmatched",
        email: "unknown@example.com",
        netid: "alove",
        username,
        displayName: "Unknown",
      });
      const [profile] = await db
        .select()
        .from(memberProfiles)
        .where(eq(memberProfiles.userId, "unmatched"));
      const [account] = await db
        .select()
        .from(user)
        .where(eq(user.id, "unmatched"));
      expect(profile!.answers).toEqual({});
      expect(account!.firstName).toBeNull();
      expect(account!.username).toBe(username ?? null);
    },
  );
});
