import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { RequestEventCommon } from "@builder.io/qwik-city";
import type { PortalDb } from "../db";
import type { FormSchemaDefinition } from "../types";
import * as tables from "../db/schema";
import type { saveSignupEdits as SaveSignupEdits } from "./edit";
import type { enqueueProvisioning as EnqueueProvisioning } from "../provisioning/outbox";
import { signupEditFields, signupEditValues } from "../forms/signup-edit";

const definition: FormSchemaDefinition = {
  fields: [
    { key: "major", label: "Major", type: "text", required: true, order: 1 },
    {
      key: "college",
      label: "College",
      type: "select",
      required: true,
      order: 2,
      options: [
        { value: "engineering", label: "Engineering" },
        { value: "other", label: "Other" },
      ],
    },
    {
      key: "interests",
      label: "Interests",
      type: "multiselect",
      required: false,
      order: 3,
      options: [
        { value: "ai", label: "AI" },
        { value: "systems", label: "Systems" },
      ],
    },
    {
      key: "contact",
      label: "Contact me",
      type: "checkbox",
      required: false,
      order: 4,
    },
    { key: "note", label: "Note", type: "textarea", required: false, order: 5 },
    {
      key: "optional_select",
      label: "Optional choice",
      type: "select",
      required: false,
      order: 6,
      options: [{ value: "yes", label: "Yes" }],
    },
    {
      key: "optional_number",
      label: "Optional number",
      type: "number",
      required: false,
      order: 7,
    },
  ],
};
const input = {
  first_name: "Grace",
  last_name: "Hopper",
  preferred_name: "Amazing Grace",
  netid: "ghopper",
  username: "grace.hopper",
  email: "grace@example.com",
  uin: "012345678",
  major: "Computer Science",
  college: "engineering",
  interests: ["ai", "systems"],
  contact: "true",
  note: "Updated note",
  optional_select: "",
  optional_number: "",
};

function event(actor: string | null = "admin-test"): RequestEventCommon {
  return {
    sharedMap: new Map(actor ? [["session", { user: { id: actor } }]] : []),
    url: new URL("https://portal.example/dashboard/admin/signups/"),
    redirect: (status: number, location: string) =>
      Object.assign(new Error(location), { status }),
    error: (status: number, message: string) =>
      Object.assign(new Error(message), { status }),
  } as unknown as RequestEventCommon;
}

function resetDb() {
  globalThis.__portalDb = undefined;
  globalThis.__portalEmbedded = undefined;
  globalThis.__pgliteClient = undefined;
  globalThis.__pgliteBoot = undefined;
  globalThis.__pgliteShutdownHooked = undefined;
}

describe("signup edits", () => {
  let db: PortalDb;
  let save: typeof SaveSignupEdits;
  let enqueue: typeof EnqueueProvisioning;
  let schemaId: string;
  let row: typeof tables.signupSubmissions.$inferSelect;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_DATA_DIR", "");
    vi.resetModules();
    resetDb();
    ({ db } = await import("../db"));
    ({ saveSignupEdits: save } = await import("./edit"));
    ({ enqueueProvisioning: enqueue } = await import("../provisioning/outbox"));
    for (const id of ["admin-test", "approver-test", "reviewer-test"]) {
      await db
        .insert(tables.user)
        .values({ id, name: id, email: `${id}@example.com` });
    }
    const [adminRole] = await db
      .select()
      .from(tables.roles)
      .where(eq(tables.roles.key, "admin"));
    await db
      .insert(tables.userRoles)
      .values({ userId: "admin-test", roleId: adminRole!.id });
    for (const [key, permissions] of [
      ["test-approver", ["signups.review", "signups.approve"]],
      ["test-reviewer", ["signups.review"]],
    ] as const) {
      const [role] = await db
        .insert(tables.roles)
        .values({ key, displayName: key })
        .returning();
      for (const permissionKey of permissions) {
        await db
          .insert(tables.rolePermissions)
          .values({ roleId: role!.id, permissionKey });
      }
      await db.insert(tables.userRoles).values({
        userId: key === "test-approver" ? "approver-test" : "reviewer-test",
        roleId: role!.id,
      });
    }
    const [schema] = await db
      .insert(tables.formSchemas)
      .values({
        formKey: "signup",
        version: 100,
        status: "archived",
        fields: definition,
      })
      .returning();
    schemaId = schema!.id;
    await db.insert(tables.formSchemas).values({
      formKey: "signup",
      version: 101,
      status: "published",
      fields: {
        fields: [
          {
            key: "new_required",
            label: "New required",
            type: "text",
            required: true,
            order: 1,
          },
        ],
      },
    });
  });

  beforeEach(async () => {
    await db.delete(tables.provisioningEvents);
    await db.delete(tables.auditEvents);
    await db.delete(tables.signupSubmissions);
    const [created] = await db
      .insert(tables.signupSubmissions)
      .values({
        schemaVersionId: schemaId,
        firstName: "Ada",
        lastName: "Lovelace",
        preferredName: "Ada",
        netid: "alove",
        username: "ada",
        email: "ada@example.com",
        uin: "111222333",
        answers: {
          major: "Math",
          college: "other",
          interests: ["ai"],
          contact: false,
          note: "Original",
          optional_select: "yes",
          optional_number: 3,
          legacy: { keep: true },
        },
        discordId: "123456789",
        discordUsername: "ada",
        discordInGuild: true,
      })
      .returning();
    row = created!;
  });

  afterAll(async () => {
    await globalThis.__pgliteClient?.close();
    resetDb();
    vi.unstubAllEnvs();
  });

  async function saved() {
    const [result] = await db
      .select()
      .from(tables.signupSubmissions)
      .where(eq(tables.signupSubmissions.id, row.id));
    return result!;
  }

  it("saves base and custom fields using the original archived schema and audits the editor", async () => {
    expect(
      await save(
        {
          ...input,
          id: row.id,
          status: "approved",
          reviewedBy: "reviewer-test",
          schemaVersionId: crypto.randomUUID(),
          discordId: "999",
          discordUsername: "fake",
          discordInGuild: false,
          legacy: "replace",
        },
        event(),
      ),
    ).toEqual({ ok: true });
    const result = await saved();
    expect(result).toMatchObject({
      firstName: "Grace",
      lastName: "Hopper",
      preferredName: "Amazing Grace",
      netid: "ghopper",
      username: "grace.hopper",
      email: "grace@example.com",
      uin: "012345678",
      status: "pending",
      reviewedBy: null,
      reviewedAt: null,
      schemaVersionId: schemaId,
      discordId: "123456789",
      discordUsername: "ada",
      discordInGuild: true,
    });
    expect(result.answers).toEqual({
      major: "Computer Science",
      college: "engineering",
      interests: ["ai", "systems"],
      contact: true,
      note: "Updated note",
      legacy: { keep: true },
    });
    const [audit] = await db.select().from(tables.auditEvents);
    expect(audit).toMatchObject({
      actorId: "admin-test",
      action: "signup.update",
      targetType: "signup_submission",
      targetId: row.id,
    });
    expect(audit!.after).toMatchObject({
      changes: expect.arrayContaining([
        { field: "first_name", oldValue: "Ada", newValue: "Grace" },
        { field: "uin", oldValue: "111222333", newValue: "012345678" },
      ]),
    });
    expect(await db.select().from(tables.provisioningEvents)).toEqual([]);
  });

  it("uses edited details when approval creates its provisioning event", async () => {
    await save({ ...input, id: row.id }, event());
    await db.transaction(async (tx) => {
      const [approved] = await tx
        .update(tables.signupSubmissions)
        .set({ status: "approved" })
        .where(
          and(
            eq(tables.signupSubmissions.id, row.id),
            eq(tables.signupSubmissions.status, "pending"),
          ),
        )
        .returning();
      await enqueue(tx, approved!, crypto.randomUUID());
    });
    const [job] = await db.select().from(tables.provisioningEvents);
    expect(job!.payload).toMatchObject({
      firstName: "Grace",
      lastName: "Hopper",
      preferredName: "Amazing Grace",
      displayName: "Amazing Grace",
      username: "grace.hopper",
      netid: "ghopper",
      uin: "012345678",
      email: "grace@example.com",
      department: "Computer Science",
      company: "Engineering",
    });
  });

  it.each([null, "reviewer-test"])(
    "rejects editing without approval permission: %s",
    async (actor) => {
      await expect(
        save({ ...input, id: row.id }, event(actor)),
      ).rejects.toMatchObject({ status: actor ? 403 : 302 });
      expect(await saved()).toEqual(row);
      expect(await db.select().from(tables.auditEvents)).toEqual([]);
    },
  );

  it("preserves and hides UIN for an approver without restricted-data access, even with a forged field", async () => {
    const result = await save(
      { ...input, id: row.id, uin: "bad-forged-uin" },
      event("approver-test"),
    );
    expect(result).toEqual({ ok: true });
    expect((await saved()).uin).toBe("111222333");
    const [audit] = await db.select().from(tables.auditEvents);
    expect(JSON.stringify(audit)).not.toContain("111222333");
    expect(JSON.stringify(result)).not.toContain("bad-forged-uin");
    expect(
      signupEditFields(definition, false).some((field) => field.key === "uin"),
    ).toBe(false);
    expect(
      signupEditValues(row, { uin: "111222333" }, false),
    ).not.toHaveProperty("uin");
  });

  it.each(["approved", "denied"] as const)(
    "rejects edits after a submission is %s",
    async (status) => {
      await db
        .update(tables.signupSubmissions)
        .set({ status })
        .where(eq(tables.signupSubmissions.id, row.id));
      expect(await save({ ...input, id: row.id }, event())).toEqual({
        ok: false,
        error: "Submission is not pending.",
      });
      expect((await saved()).firstName).toBe("Ada");
      expect(await db.select().from(tables.auditEvents)).toEqual([]);
    },
  );

  it.each(["invalid-id", crypto.randomUUID()])(
    "rejects missing or malformed IDs: %s",
    async (id) => {
      expect((await save({ ...input, id }, event())).ok).toBe(false);
      expect(await saved()).toEqual(row);
    },
  );

  it.each([
    ["first_name", ""],
    ["username", "invalid@name"],
    ["uin", "123"],
    ["email", "grace@uic.edu"],
    ["college", "unlisted"],
    ["interests", ["unlisted"]],
    ["major", ""],
  ])(
    "validates %s and leaves the submission and audit untouched",
    async (field, value) => {
      const result = await save(
        { ...input, id: row.id, [field as string]: value },
        event(),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors).toHaveProperty(field as string);
      expect(await saved()).toEqual(row);
      expect(await db.select().from(tables.auditEvents)).toEqual([]);
    },
  );

  it("blocks NetID and username conflicts with another pending signup", async () => {
    await db
      .insert(tables.signupSubmissions)
      .values({
        ...row,
        id: crypto.randomUUID(),
        netid: input.netid,
        username: input.username,
        discordId: null,
      });
    const result = await save({ ...input, id: row.id }, event());
    expect(result).toMatchObject({
      ok: false,
      errors: {
        netid: expect.stringContaining("pending"),
        username: expect.stringContaining("pending"),
      },
    });
    expect(await saved()).toEqual(row);
  });

  it("blocks NetID and username conflicts with existing accounts", async () => {
    await db
      .update(tables.user)
      .set({ netid: input.netid, username: input.username })
      .where(eq(tables.user.id, "reviewer-test"));
    try {
      const result = await save({ ...input, id: row.id }, event());
      expect(result).toMatchObject({
        ok: false,
        errors: {
          netid: expect.stringContaining("already in use"),
          username: expect.stringContaining("already in use"),
        },
      });
      expect(await saved()).toEqual(row);
    } finally {
      await db
        .update(tables.user)
        .set({ netid: null, username: null })
        .where(eq(tables.user.id, "reviewer-test"));
    }
  });

  it("allows clearing preferred name, checkboxes, and multiselects", async () => {
    const { contact: _contact, interests: _interests, ...unchecked } = input;
    expect(
      await save({ ...unchecked, preferred_name: " ", id: row.id }, event()),
    ).toEqual({ ok: true });
    expect(await saved()).toMatchObject({
      preferredName: null,
      answers: { contact: false, interests: [] },
    });
  });

  it("does not create an audit event for an unchanged submission", async () => {
    expect(
      await save(
        {
          ...signupEditValues(
            row,
            row.answers as Record<string, unknown>,
            true,
          ),
          id: row.id,
        },
        event(),
      ),
    ).toEqual({ ok: true });
    expect(await saved()).toEqual(row);
    expect(await db.select().from(tables.auditEvents)).toEqual([]);
  });

  it("rolls back the edit when its audit event cannot be saved", async () => {
    await db.execute(
      sql`CREATE FUNCTION fail_signup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Audit unavailable'; END; $$`,
    );
    await db.execute(
      sql`CREATE TRIGGER fail_signup_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_signup_audit()`,
    );
    try {
      await expect(save({ ...input, id: row.id }, event())).rejects.toThrow();
      expect(await saved()).toEqual(row);
      expect(await db.select().from(tables.auditEvents)).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER fail_signup_audit ON audit_events`);
      await db.execute(sql`DROP FUNCTION fail_signup_audit()`);
    }
  });
});
