import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq, sql } from "drizzle-orm";
import type { PortalDb } from "../db";
import * as tables from "../db/schema";
import type { PortalSession } from "../types";
import type { saveProfile as SaveProfile } from "./save";
import type { createPendingSignup as CreateSignup } from "../signups/create";

const { syncAdUser } = vi.hoisted(() => ({
  syncAdUser: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../provisioning/ad-sync", () => ({ syncAdUser }));

function resetDb() {
  globalThis.__portalDb = undefined;
  globalThis.__portalEmbedded = undefined;
  globalThis.__pgliteClient = undefined;
  globalThis.__pgliteBoot = undefined;
  globalThis.__pgliteShutdownHooked = undefined;
}

const member = {
  id: "member",
  name: "Original Member",
  email: "member@example.com",
  username: "original",
  netid: "shared",
  firstName: "Original",
  lastName: "Member",
  uin: "012345678",
};
const input = {
  first_name: "Changed",
  last_name: "Member",
  preferred_name: "",
  email: "changed@example.com",
  username: "reserved",
  netid: "shared",
  uin: "012345678",
  major: "Changed major",
};
const session = { user: { id: member.id } } as PortalSession;

describe("profile username claims", () => {
  let db: PortalDb;
  let saveProfile: typeof SaveProfile;
  let createSignup: typeof CreateSignup;
  let schemaId: string;
  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_DATA_DIR", "");
    vi.resetModules();
    resetDb();
    ({ db } = await import("../db"));
    ({ saveProfile } = await import("./save"));
    ({ createPendingSignup: createSignup } = await import("../signups/create"));
    const [schema] = await db
      .insert(tables.formSchemas)
      .values({
        formKey: "signup",
        version: 777,
        status: "published",
        fields: {
          fields: [
            {
              key: "major",
              label: "Major",
              type: "text",
              required: true,
              order: 1,
            },
          ],
        },
      })
      .returning();
    schemaId = schema!.id;
  });
  beforeEach(async () => {
    syncAdUser.mockClear();
    await db.delete(tables.auditEvents);
    await db.delete(tables.provisioningEvents);
    await db.delete(tables.signupSubmissions);
    await db.delete(tables.user);
    await db.insert(tables.user).values(member);
    await db
      .insert(tables.memberProfiles)
      .values({ userId: member.id, answers: { major: "Original major" } });
  });
  afterAll(async () => {
    await globalThis.__pgliteClient?.close();
    resetDb();
    vi.unstubAllEnvs();
  });
  function submission(
    username = input.username,
    status: "pending" | "approved" | "denied" = "pending",
  ) {
    return {
      schemaVersionId: schemaId,
      firstName: "Applicant",
      lastName: "Member",
      username,
      netid: "shared",
      email: "applicant@example.com",
      answers: {},
      status,
    };
  }
  async function snapshot() {
    return {
      users: await db.select().from(tables.user),
      profiles: await db.select().from(tables.memberProfiles),
      audits: await db.select().from(tables.auditEvents),
    };
  }
  it.each(["pending", "approved"] as const)(
    "rejects profile renames to a %s signup before its account exists",
    async (status) => {
      await db
        .insert(tables.signupSubmissions)
        .values(submission(input.username, status));
      const before = await snapshot();
      expect(await saveProfile(input, session)).toEqual({
        ok: false,
        errors: { username: expect.stringContaining("reserved") },
      });
      expect(await snapshot()).toEqual(before);
      expect(syncAdUser).not.toHaveBeenCalled();
      await expect(
        db
          .update(tables.user)
          .set({ username: input.username })
          .where(eq(tables.user.id, member.id)),
      ).rejects.toMatchObject({
        cause: { code: "23505", constraint: "username_claims_username_key" },
      });
    },
  );
  it("rolls back a profile save when a signup reserves its username after the precheck", async () => {
    const before = await snapshot();
    await db.execute(
      sql.raw(`CREATE FUNCTION reserve_during_profile_save() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO signup_submissions (schema_version_id, first_name, last_name, netid, username, email, answers, status)
          VALUES ('${schemaId}', 'Applicant', 'Member', 'shared', NEW.username, 'applicant@example.com', '{}', 'approved');
        RETURN NEW;
      END; $$`),
    );
    await db.execute(sql`CREATE TRIGGER reserve_during_profile_save BEFORE UPDATE OF username ON "user"
      FOR EACH ROW EXECUTE FUNCTION reserve_during_profile_save()`);
    try {
      expect(await saveProfile(input, session)).toEqual({
        ok: false,
        errors: { username: expect.stringContaining("reserved") },
      });
      expect(await snapshot()).toEqual(before);
      expect(await db.select().from(tables.signupSubmissions)).toEqual([]);
      expect(
        (await db.select().from(tables.usernameClaims)).map((c) => c.username),
      ).toEqual([member.username]);
      expect(syncAdUser).not.toHaveBeenCalled();
    } finally {
      await db.execute(sql`DROP TRIGGER reserve_during_profile_save ON "user"`);
      await db.execute(sql`DROP FUNCTION reserve_during_profile_save()`);
    }
  });
  it("serializes a new signup and a member rename claiming the same username", async () => {
    const [renamed, created] = await Promise.allSettled([
      db
        .update(tables.user)
        .set({ username: input.username })
        .where(eq(tables.user.id, member.id))
        .returning(),
      createSignup(submission()),
    ]);
    const successes =
      Number(renamed.status === "fulfilled") +
      Number(created.status === "fulfilled" && created.value.ok);
    expect(successes).toBe(1);
    const [claim] = await db
      .select()
      .from(tables.usernameClaims)
      .where(eq(tables.usernameClaims.username, input.username));
    expect(Boolean(claim!.userId)).not.toBe(Boolean(claim!.signupSubmissionId));
  });
  it("serializes a signup edit and member rename claiming the same username", async () => {
    const [signup] = await db
      .insert(tables.signupSubmissions)
      .values(submission("applicant"))
      .returning();
    const outcomes = await Promise.allSettled([
      db
        .update(tables.user)
        .set({ username: input.username })
        .where(eq(tables.user.id, member.id)),
      db
        .update(tables.signupSubmissions)
        .set({ username: input.username })
        .where(eq(tables.signupSubmissions.id, signup!.id)),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const [claim] = await db
      .select()
      .from(tables.usernameClaims)
      .where(eq(tables.usernameClaims.username, input.username));
    expect(Boolean(claim!.userId)).not.toBe(Boolean(claim!.signupSubmissionId));
  });
  it("allows a member to save their unchanged username attached to their approved signup", async () => {
    const [signup] = await db
      .insert(tables.signupSubmissions)
      .values(submission(input.username, "approved"))
      .returning();
    await db.insert(tables.user).values({
      ...member,
      id: "applicant",
      username: input.username,
      email: "applicant@example.com",
    });
    await db
      .insert(tables.memberProfiles)
      .values({ userId: "applicant", answers: {} });
    expect(
      await saveProfile(input, { user: { id: "applicant" } } as PortalSession),
    ).toMatchObject({ ok: true });
    const [claim] = await db
      .select()
      .from(tables.usernameClaims)
      .where(eq(tables.usernameClaims.username, input.username));
    expect(claim).toMatchObject({
      userId: "applicant",
      signupSubmissionId: signup!.id,
    });
  });
  it("allows a denied username and releases the member's previous unreserved username", async () => {
    await db
      .insert(tables.signupSubmissions)
      .values(submission(input.username, "denied"));
    expect(await saveProfile(input, session)).toMatchObject({ ok: true });
    expect(
      await db
        .select()
        .from(tables.usernameClaims)
        .where(eq(tables.usernameClaims.username, member.username)),
    ).toEqual([]);
    expect(syncAdUser).toHaveBeenCalledWith(
      expect.objectContaining({
        samAccountName: member.username,
        username: input.username,
      }),
    );
  });
});
