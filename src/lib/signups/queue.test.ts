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
import type * as ManualDelivery from "../provisioning/manual-delivery";
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
  let manual: typeof ManualDelivery;
  const actorId = crypto.randomUUID();
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
    manual = await import("../provisioning/manual-delivery");
    await db.insert(tables.user).values({
      id: actorId,
      name: "Signup reviewer",
      email: "reviewer@example.com",
    });
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

  async function manualEvent() {
    const row = await signup("approved");
    const id = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, id, "admin");
    return { row, id };
  }
  function credentialsResponse(
    username: string,
    oneTimePassword = "manual-secret",
  ) {
    return new Response(
      JSON.stringify({
        samAccountName: username,
        existed: true,
        oneTimePassword,
      }),
    );
  }

  it("shows manual credentials without email or persisted passwords, keeping the signup until acknowledgement", async () => {
    const { row, id } = await manualEvent();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(credentialsResponse(row.username));
    expect(await drainOnce(fetchImpl)).toBe(false);
    const result = await manual.revealManualCredentials(id, actorId, fetchImpl);
    expect(result).toMatchObject({
      username: row.username,
      oneTimePassword: "manual-secret",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body))).toMatchObject(
      { eventId: id, retryCredentialDelivery: true },
    );
    expect(sendCredentialEmail).not.toHaveBeenCalled();
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      {
        id: row.id,
        credentialDeliveryMode: "admin",
        provisioningStatus: "pending",
      },
    ]);
    const events = await db.select().from(tables.provisioningEvents);
    const audit = await db.select().from(tables.auditEvents);
    expect(
      JSON.stringify([events, audit, await queue.loadSignupQueue(false)]),
    ).not.toContain("manual-secret");
    expect(await drainOnce(fetchImpl)).toBe(false);
    expect(
      await manual.confirmManualDelivery(id, crypto.randomUUID(), actorId),
    ).toBe(false);
    expect(await manual.confirmManualDelivery(id, result.token, actorId)).toBe(
      true,
    );
    expect(await queue.loadSignupQueue(false)).toEqual([]);
    expect(await manual.confirmManualDelivery(id, result.token, actorId)).toBe(
      false,
    );
    await expect(
      manual.revealManualCredentials(id, actorId, fetchImpl),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers a lost manual response with fresh credentials and rejects the old acknowledgement", async () => {
    const { row, id } = await manualEvent();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(credentialsResponse(row.username, "old-secret"))
      .mockResolvedValueOnce(credentialsResponse(row.username, "new-secret"));
    const old = await manual.revealManualCredentials(id, actorId, fetchImpl);
    vi.resetModules();
    manual = await import("../provisioning/manual-delivery");
    const current = await manual.revealManualCredentials(
      id,
      actorId,
      fetchImpl,
    );
    expect(current.oneTimePassword).toBe("new-secret");
    expect(await manual.confirmManualDelivery(id, old.token, actorId)).toBe(
      false,
    );
    expect(await queue.loadSignupQueue(false)).toHaveLength(1);
    expect(await manual.confirmManualDelivery(id, current.token, actorId)).toBe(
      true,
    );
    expect(await queue.loadSignupQueue(false)).toEqual([]);
    expect(sendCredentialEmail).not.toHaveBeenCalled();
  });

  it("retains a failed manual signup without scheduling email and permits a manual retry", async () => {
    const { row, id } = await manualEvent();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("AD unavailable"))
      .mockResolvedValueOnce(credentialsResponse(row.username));
    await expect(
      manual.revealManualCredentials(id, actorId, fetchImpl),
    ).rejects.toMatchObject({ status: 502 });
    expect(await queue.loadSignupQueue(false)).toMatchObject([
      { provisioningStatus: "failed", provisioningError: "AD unavailable" },
    ]);
    expect(await outbox.retryProvisioning(id)).toBe(false);
    expect(await drainOnce(fetchImpl)).toBe(false);
    const result = await manual.revealManualCredentials(id, actorId, fetchImpl);
    expect(await manual.confirmManualDelivery(id, result.token, actorId)).toBe(
      true,
    );
    expect(sendCredentialEmail).not.toHaveBeenCalled();
  });

  it("rejects overlapping reveals and stale confirmations while a new password is being created", async () => {
    const { row, id } = await manualEvent();
    const initial = await manual.revealManualCredentials(
      id,
      actorId,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(credentialsResponse(row.username)),
    );
    let release!: (response: Response) => void;
    let started!: () => void;
    const claimed = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const pending = manual.revealManualCredentials(id, actorId, fetchImpl);
    await claimed;
    await expect(
      manual.revealManualCredentials(id, actorId, fetchImpl),
    ).rejects.toMatchObject({ status: 409 });
    expect(await manual.confirmManualDelivery(id, initial.token, actorId)).toBe(
      false,
    );
    expect(await drainOnce(fetchImpl)).toBe(false);
    release(credentialsResponse(row.username, "next-secret"));
    const next = await pending;
    expect(await manual.confirmManualDelivery(id, next.token, actorId)).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reclaims a crashed manual request without allowing the email worker to process it", async () => {
    const { row, id } = await manualEvent();
    await db
      .update(tables.provisioningEvents)
      .set({
        status: "processing",
        updatedAt: new Date(Date.now() - 6 * 60_000),
      })
      .where(eq(tables.provisioningEvents.id, id));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(credentialsResponse(row.username));
    expect(await drainOnce(fetchImpl)).toBe(false);
    const result = await manual.revealManualCredentials(id, actorId, fetchImpl);
    expect(await manual.confirmManualDelivery(id, result.token, actorId)).toBe(
      true,
    );
  });

  it("fails manual provisioning in production when the directory API is not configured", async () => {
    const { id } = await manualEvent();
    vi.stubEnv("WINDOWS_API_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        manual.revealManualCredentials(id, actorId),
      ).rejects.toMatchObject({ status: 502 });
      expect(await queue.loadSignupQueue(false)).toMatchObject([
        {
          provisioningStatus: "failed",
          provisioningError: "Directory provisioning is not configured.",
        },
      ]);
      expect(sendCredentialEmail).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("WINDOWS_API_URL", "https://directory.example");
    }
  });

  it("does not reveal email events or complete manual delivery without a password", async () => {
    const email = await signup("approved");
    const emailId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, email, emailId);
    const { row, id } = await manualEvent();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ samAccountName: row.username, existed: true }),
        ),
      );
    await expect(
      manual.revealManualCredentials(emailId, actorId, fetchImpl),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      manual.revealManualCredentials(id, actorId, fetchImpl),
    ).rejects.toMatchObject({ status: 502 });
    expect(await queue.loadSignupQueue(false)).toHaveLength(2);
    expect(sendCredentialEmail).not.toHaveBeenCalled();
  });

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

  it.each(["admin", "email"] as const)(
    "keeps a local signup queued when its OAuth-only user has no password account: %s",
    async (mode) => {
      const row = await signup("approved");
      const id = crypto.randomUUID();
      const userId = crypto.randomUUID();
      await db.insert(tables.user).values({
        id: userId,
        name: "Alex Smith",
        email: row.email,
        username: row.username,
      });
      await db.insert(tables.account).values({
        id: crypto.randomUUID(),
        userId,
        providerId: "discord",
        issuer: "local:oauth:discord",
        accountId: userId,
      });
      await outbox.enqueueProvisioning(db, row, id, mode);
      vi.stubEnv("WINDOWS_API_URL", "");
      try {
        if (mode === "admin") {
          await expect(
            manual.revealManualCredentials(id, actorId),
          ).rejects.toThrow("Account setup failed.");
        } else {
          await drainOnce();
        }
        expect(await queue.loadSignupQueue(false)).toMatchObject([
          { id: row.id, provisioningStatus: "failed" },
        ]);
        expect(sendCredentialEmail).not.toHaveBeenCalled();
        const accounts = await db
          .select()
          .from(tables.account)
          .where(eq(tables.account.userId, userId));
        expect(accounts).toMatchObject([
          { providerId: "discord", password: null },
        ]);
      } finally {
        vi.stubEnv("WINDOWS_API_URL", "https://directory.example");
      }
    },
  );

  it("updates the local password before emailing a retry after a delivery receipt fails", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    const currentOutbox = await import("../provisioning/outbox");
    const saveDelivery = currentOutbox.markCredentialDelivery;
    const lockClaim = currentOutbox.withProvisioningClaim;
    let activeTx: Outbox.DbOrTx;
    const lock = vi
      .spyOn(currentOutbox, "withProvisioningClaim")
      .mockImplementation((claim, work) =>
        lockClaim(claim, async (tx) => {
          activeTx = tx;
          return work(tx);
        }),
      );
    let failReceipt = true;
    const receipt = vi
      .spyOn(currentOutbox, "markCredentialDelivery")
      .mockImplementation(async (claim, status, tx) => {
        if (status === "delivered" && failReceipt) {
          failReceipt = false;
          throw new Error("delivery receipt unavailable");
        }
        return saveDelivery(claim, status, tx);
      });
    vi.stubEnv("WINDOWS_API_URL", "");
    try {
      const { verifyPassword } = await import("better-auth/crypto");
      sendCredentialEmail.mockImplementation(async ({ oneTimePassword }) => {
        const [login] = await activeTx
          .select({ password: tables.account.password })
          .from(tables.account)
          .innerJoin(tables.user, eq(tables.user.id, tables.account.userId))
          .where(eq(tables.user.email, row.email));
        expect(login?.password).toBeTruthy();
        expect(
          await verifyPassword({
            hash: login!.password!,
            password: oneTimePassword,
          }),
        ).toBe(true);
      });
      await drainOnce();
      expect(await queue.loadSignupQueue(false)).toMatchObject([
        {
          id: row.id,
          provisioningStatus: "failed",
          provisioningError: "delivery receipt unavailable",
        },
      ]);
      expect(await outbox.retryProvisioning(eventId)).toBe(true);
      await drainOnce();
      expect(sendCredentialEmail).toHaveBeenCalledTimes(2);
      const firstPassword =
        sendCredentialEmail.mock.calls[0]![0].oneTimePassword;
      const latestPassword =
        sendCredentialEmail.mock.calls[1]![0].oneTimePassword;
      expect(latestPassword).not.toBe(firstPassword);
      expect(await queue.loadSignupQueue(false)).toEqual([]);
      const { auth } = await import("../auth");
      expect(
        await auth.api.signInEmail({
          body: { email: row.email, password: latestPassword },
        }),
      ).toMatchObject({ user: { email: row.email, username: row.username } });
      await expect(
        auth.api.signInEmail({
          body: { email: row.email, password: firstPassword },
        }),
      ).rejects.toThrow();
    } finally {
      receipt.mockRestore();
      lock.mockRestore();
      vi.stubEnv("WINDOWS_API_URL", "https://directory.example");
    }
  });

  it("rejects every progress write and external operation from a reclaimed claim", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    const oldClaim = (await outbox.claimNext())!;
    await db
      .update(tables.provisioningEvents)
      .set({ updatedAt: new Date(0) })
      .where(eq(tables.provisioningEvents.id, eventId));
    const newClaim = (await outbox.claimNext())!;
    expect(newClaim.claimToken).not.toBe(oldClaim.claimToken);
    const work = vi.fn();
    expect(await outbox.withProvisioningClaim(oldClaim, work)).toEqual({
      owned: false,
    });
    expect(work).not.toHaveBeenCalled();
    expect(await outbox.markCredentialDelivery(oldClaim, "pending")).toBe(
      false,
    );
    expect(await outbox.markCredentialDelivery(oldClaim, "delivered")).toBe(
      false,
    );
    expect(await outbox.markProvisioned(oldClaim)).toBe(false);
    expect(await outbox.markFailed(oldClaim, "stale error", 99)).toBe(false);
    expect(await outbox.markCredentialDelivery(newClaim, "delivered")).toBe(
      true,
    );
    expect(await outbox.markProvisioned(newClaim)).toBe(true);
    expect(await outbox.markFailed(oldClaim, "late stale error", 99)).toBe(
      false,
    );
    const [completed] = await db
      .select()
      .from(tables.provisioningEvents)
      .where(eq(tables.provisioningEvents.id, eventId));
    expect(completed).toMatchObject({
      status: "provisioned",
      credentialDeliveryStatus: "delivered",
      claimToken: newClaim.claimToken,
      lastError: null,
    });
  });

  it("does not email the old password when another worker reclaims between directory setup and delivery", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(credentialsResponse(row.username, "old-secret"))
      .mockResolvedValueOnce(credentialsResponse(row.username, "new-secret"));
    const currentOutbox = await import("../provisioning/outbox");
    const runClaim = currentOutbox.withProvisioningClaim;
    let phases = 0;
    const lock = vi
      .spyOn(currentOutbox, "withProvisioningClaim")
      .mockImplementation(async (claim, work) => {
        if (++phases === 2) {
          await db
            .update(tables.provisioningEvents)
            .set({ updatedAt: new Date(0) })
            .where(eq(tables.provisioningEvents.id, eventId));
          await drainOnce(fetchImpl);
        }
        return runClaim(claim, work);
      });
    try {
      await drainOnce(fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sendCredentialEmail).toHaveBeenCalledExactlyOnceWith({
        to: row.email,
        username: row.username,
        oneTimePassword: "new-secret",
      });
      expect(await queue.loadSignupQueue(false)).toEqual([]);
      const [completed] = await db
        .select()
        .from(tables.provisioningEvents)
        .where(eq(tables.provisioningEvents.id, eventId));
      expect(completed).toMatchObject({
        status: "provisioned",
        credentialDeliveryStatus: "delivered",
      });
    } finally {
      lock.mockRestore();
    }
  });

  it("does not complete pending credential delivery when a replay has no password", async () => {
    const row = await signup("approved");
    const eventId = crypto.randomUUID();
    await outbox.enqueueProvisioning(db, row, eventId);
    await db
      .update(tables.provisioningEvents)
      .set({ credentialDeliveryStatus: "pending" })
      .where(eq(tables.provisioningEvents.id, eventId));
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
