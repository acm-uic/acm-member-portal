import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { eq } from "drizzle-orm";
import type { PortalDb } from "../db";
import * as tables from "../db/schema";
import type * as Queue from "./queue";
import type * as Outbox from "../provisioning/outbox";
import type { drainOnce as DrainOnce } from "../../worker/provisioning";

const sendCredentialEmail = vi.hoisted(() => vi.fn());
vi.mock("../mail/templates", () => ({ sendCredentialEmail }));

function resetDb() {
  globalThis.__portalDb = undefined;
  globalThis.__portalEmbedded = undefined;
  globalThis.__pgliteClient = undefined;
  globalThis.__pgliteBoot = undefined;
  globalThis.__pgliteShutdownHooked = undefined;
}

describe("signup queue through AD provisioning", () => {
  let db: PortalDb;
  let queue: typeof Queue;
  let outbox: typeof Outbox;
  let drainOnce: typeof DrainOnce;
  let schemaId: string;

  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_DATA_DIR", "");
    vi.stubEnv("WINDOWS_API_URL", "https://directory.example");
    vi.stubEnv("WINDOWS_API_TOKEN", "test-token");
    vi.resetModules();
    resetDb();
    ({ db } = await import("../db"));
    queue = await import("./queue");
    outbox = await import("../provisioning/outbox");
    ({ drainOnce } = await import("../../worker/provisioning"));
    const [schema] = await db
      .select()
      .from(tables.formSchemas)
      .where(eq(tables.formSchemas.formKey, "signup"))
      .limit(1);
    schemaId = schema!.id;
  });

  beforeEach(async () => {
    sendCredentialEmail.mockReset().mockResolvedValue(undefined);
    await db.delete(tables.provisioningEvents);
    await db.delete(tables.signupSubmissions);
  });

  afterAll(async () => {
    await globalThis.__pgliteClient?.close();
    resetDb();
    vi.unstubAllEnvs();
  });

  async function signup(status: "pending" | "approved" | "denied" = "pending") {
    const username = `user-${crypto.randomUUID()}`;
    const [row] = await db
      .insert(tables.signupSubmissions)
      .values({
        schemaVersionId: schemaId,
        firstName: "Alex",
        lastName: "Smith",
        netid: username,
        username,
        email: `${username}@example.com`,
        uin: "123456789",
        answers: {},
        status,
      })
      .returning();
    return row!;
  }

  async function event(
    submissionId: string,
    status: typeof tables.provisioningEvents.$inferSelect.status,
    extra = {},
  ) {
    const [row] = await db
      .insert(tables.provisioningEvents)
      .values({
        submissionId,
        status,
        payload: {},
        ...extra,
      })
      .returning();
    return row!;
  }

  it("keeps an approved signup through API failure and retry, then removes it after success", async () => {
    const row = await signup();
    expect((await queue.loadSignupQueue(false)).map((s) => s.id)).toContain(
      row.id,
    );
    const eventId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      const [approved] = await tx
        .update(tables.signupSubmissions)
        .set({ status: "approved" })
        .where(eq(tables.signupSubmissions.id, row.id))
        .returning();
      await outbox.enqueueProvisioning(tx, approved!, eventId);
    });
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      { id: row.id, status: "approved", provisioningStatus: "pending" },
    ]);

    const fail = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ error: "AD create failed: ENTRY_EXISTS" }),
          { status: 502 },
        ),
      );
    expect(await drainOnce(fail)).toBe(true);
    const [failed] = await queue.loadSignupQueue(false);
    expect(failed).toMatchObject({ id: row.id, provisioningStatus: "failed" });
    expect(failed!.provisioningError).toContain("ENTRY_EXISTS");
    expect(await outbox.retryProvisioning(eventId)).toBe(true);
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      { id: row.id, provisioningStatus: "pending", provisioningError: null },
    ]);

    const succeed = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ samAccountName: row.username, existed: true }),
          { status: 200 },
        ),
      );
    expect(await drainOnce(succeed)).toBe(true);
    expect(await queue.loadSignupQueue(false)).toEqual([]);
    const [saved] = await db
      .select()
      .from(tables.signupSubmissions)
      .where(eq(tables.signupSubmissions.id, row.id));
    expect(saved!.status).toBe("approved");
  });

  it("shows approved signups in every unfinished state, including a missing event", async () => {
    const unfinished = [];
    for (const status of [
      "pending",
      "processing",
      "failed",
      "dead_lettered",
    ] as const) {
      const row = await signup("approved");
      await event(row.id, status, {
        lastError: status === "failed" ? "AD unavailable" : null,
      });
      unfinished.push(row.id);
    }
    const missing = await signup("approved");
    unfinished.push(missing.id);
    await signup("denied");
    const completed = await signup("approved");
    await event(completed.id, "provisioned");
    const rows = await queue.loadSignupQueue(false);
    expect(rows.map((s) => s.id).sort()).toEqual(unfinished.sort());
    expect(rows.find((s) => s.id === missing.id)?.provisioningId).toBeNull();
  });

  it("uses the latest event without duplicating a signup and hides any completed signup", async () => {
    const row = await signup("approved");
    await event(row.id, "failed", {
      createdAt: new Date("2026-10-01"),
      lastError: "Old error",
    });
    const latest = await event(row.id, "dead_lettered", {
      createdAt: new Date("2026-10-02"),
      lastError: "Current error",
    });
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      {
        id: row.id,
        provisioningId: latest.id,
        provisioningError: "Current error",
      },
    ]);
    await event(row.id, "provisioned", { createdAt: new Date("2026-09-30") });
    expect(await queue.loadSignupQueue(false)).toEqual([]);
  });

  it("keeps restricted UIN values out of the queue response", async () => {
    await signup();
    const [restricted] = await queue.loadSignupQueue(false);
    expect(restricted).not.toHaveProperty("uin");
    const [allowed] = await queue.loadSignupQueue(true);
    expect(allowed!.uin).toBe("123456789");
  });

  it("keeps older failed signups reachable beyond the first page", async () => {
    const older = await signup("approved");
    await db
      .update(tables.signupSubmissions)
      .set({ createdAt: new Date("2026-01-01") })
      .where(eq(tables.signupSubmissions.id, older.id));
    await event(older.id, "failed", { lastError: "AD unavailable" });
    const newer = await signup();
    expect(await queue.loadSignupQueue(false, 1, 0)).toMatchObject([
      { id: newer.id },
    ]);
    expect(await queue.loadSignupQueue(false, 1, 1)).toMatchObject([
      { id: older.id, provisioningError: "AD unavailable" },
    ]);
  });

  it("does not retry pending, processing, or completed work", async () => {
    for (const status of ["pending", "processing", "provisioned"] as const) {
      const row = await signup("approved");
      const queued = await event(row.id, status, { attempts: 3 });
      expect(await outbox.retryProvisioning(queued.id)).toBe(false);
      const [unchanged] = await db
        .select()
        .from(tables.provisioningEvents)
        .where(eq(tables.provisioningEvents.id, queued.id));
      expect(unchanged).toMatchObject({ status, attempts: 3 });
    }
  });

  it("allows just one of two concurrent retries of an exhausted event", async () => {
    const row = await signup("approved");
    const queued = await event(row.id, "dead_lettered", {
      attempts: 10,
      lastError: "AD unavailable",
    });
    const results = await Promise.all([
      outbox.retryProvisioning(queued.id),
      outbox.retryProvisioning(queued.id),
    ]);
    expect(results.sort()).toEqual([false, true]);
    const [retried] = await db
      .select()
      .from(tables.provisioningEvents)
      .where(eq(tables.provisioningEvents.id, queued.id));
    expect(retried).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
  });

  it("keeps the signup visible when HTTP 200 does not confirm its AD account", async () => {
    const row = await signup("approved");
    await outbox.enqueueProvisioning(db, row, crypto.randomUUID());
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await drainOnce(fetchImpl);
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      {
        id: row.id,
        provisioningStatus: "failed",
        provisioningError:
          "Provisioning API returned an invalid account-creation response.",
      },
    ]);
  });

  it("displays API errors without JSON formatting or AD NUL padding", () => {
    expect(
      queue.provisioningErrorText(
        `Provisioning API 502: ${JSON.stringify({ error: "ENTRY_EXISTS\n\0\0" })}`,
      ),
    ).toBe("ENTRY_EXISTS");
    expect(queue.provisioningErrorText("fetch failed")).toBe("fetch failed");
    expect(
      queue.provisioningErrorText(
        'Provisioning API 502: {"error":"ENTRY_EXISTS\\n\\u0000\\u00',
      ),
    ).toBe("ENTRY_EXISTS");
    expect(queue.provisioningErrorText(null)).toBeNull();
    expect(queue.provisioningErrorText("Provisioning API 502: null")).toBe(
      "Provisioning API 502: null",
    );
  });

  it("retains failed credential delivery across worker reloads and sends reissued credentials on retry", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    sendCredentialEmail.mockRejectedValueOnce(new Error("SMTP unavailable"));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            samAccountName: row.username,
            existed: false,
            oneTimePassword: "initial-secret",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            samAccountName: row.username,
            existed: true,
            oneTimePassword: "replacement-secret",
          }),
        ),
      );
    await drainOnce(fetchImpl);
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      {
        id: row.id,
        provisioningStatus: "failed",
        provisioningError: "SMTP unavailable",
      },
    ]);
    const [failed] = await db
      .select()
      .from(tables.provisioningEvents)
      .where(eq(tables.provisioningEvents.id, eventId));
    expect(failed!.credentialDeliveryStatus).toBe("pending");
    expect(JSON.stringify(failed)).not.toContain("initial-secret");

    // Reload the worker to ensure recovery does not depend on an in-memory password.
    vi.resetModules();
    ({ drainOnce } = await import("../../worker/provisioning"));
    expect(await outbox.retryProvisioning(eventId)).toBe(true);
    await drainOnce(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retryPayload = JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body));
    expect(retryPayload).toMatchObject({
      eventId,
      retryCredentialDelivery: true,
    });
    expect(sendCredentialEmail).toHaveBeenLastCalledWith({
      to: row.email,
      username: row.username,
      oneTimePassword: "replacement-secret",
    });
    expect(await queue.loadSignupQueue(false)).toEqual([]);
    const [completed] = await db
      .select()
      .from(tables.provisioningEvents)
      .where(eq(tables.provisioningEvents.id, eventId));
    expect(completed!.credentialDeliveryStatus).toBe("delivered");
    expect(JSON.stringify(completed)).not.toContain("replacement-secret");
  });

  it("does not complete pending credential delivery when a replay has no password", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    await outbox.markCredentialDelivery(eventId, "pending");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          samAccountName: row.username,
          existed: true,
        }),
      ),
    );
    await drainOnce(fetchImpl);
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      { id: row.id, provisioningStatus: "failed" },
    ]);
    expect(sendCredentialEmail).not.toHaveBeenCalled();
  });

  it("does not reissue or resend credentials if event completion fails after delivery", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    const currentOutbox = await import("../provisioning/outbox");
    const completion = vi
      .spyOn(currentOutbox, "markProvisioned")
      .mockRejectedValueOnce(new Error("completion unavailable"));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          samAccountName: row.username,
          existed: false,
          oneTimePassword: "initial-secret",
        }),
      ),
    );
    try {
      await drainOnce(fetchImpl);
      const [failed] = await db
        .select()
        .from(tables.provisioningEvents)
        .where(eq(tables.provisioningEvents.id, eventId));
      expect(failed).toMatchObject({
        status: "failed",
        credentialDeliveryStatus: "delivered",
      });
      await outbox.retryProvisioning(eventId);
      await drainOnce(fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sendCredentialEmail).toHaveBeenCalledTimes(1);
      expect(await queue.loadSignupQueue(false)).toEqual([]);
    } finally {
      completion.mockRestore();
    }
  });

  it("recovers a lost account-creation response using the event-owned credential retry", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            samAccountName: row.username,
            existed: true,
            oneTimePassword: "replacement-secret",
          }),
        ),
      );
    await drainOnce(fetchImpl);
    await outbox.retryProvisioning(eventId);
    await drainOnce(fetchImpl);
    expect(sendCredentialEmail).toHaveBeenCalledTimes(1);
    expect(await queue.loadSignupQueue(false)).toEqual([]);
  });

  it("rejects malformed passwords even on an existing-account response", async () => {
    const row = await signup("approved");
    await outbox.enqueueProvisioning(db, row, crypto.randomUUID());
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          samAccountName: row.username,
          existed: true,
          oneTimePassword: 123,
        }),
      ),
    );
    await drainOnce(fetchImpl);
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      { id: row.id, provisioningStatus: "failed" },
    ]);
    expect(sendCredentialEmail).not.toHaveBeenCalled();
  });
});
