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
import type * as Outbox from "./outbox";
import type * as Page from "./log-page";
import type * as Manual from "./manual-delivery";
import type { drainOnce as Drain } from "../../worker/provisioning";

const mail = vi.hoisted(() => vi.fn());
vi.mock("../mail/templates", () => ({ sendCredentialEmail: mail }));
function resetDb() {
  globalThis.__portalDb = undefined;
  globalThis.__portalEmbedded = undefined;
  globalThis.__pgliteClient = undefined;
  globalThis.__pgliteBoot = undefined;
  globalThis.__pgliteShutdownHooked = undefined;
}

describe("persistent provisioning diagnostics", () => {
  let db: PortalDb;
  let outbox: typeof Outbox;
  let page: typeof Page;
  let manual: typeof Manual;
  let drain: typeof Drain;
  let schemaId: string;
  const actorId = crypto.randomUUID();
  beforeAll(async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("PGLITE_DATA_DIR", "");
    vi.stubEnv("WINDOWS_API_URL", "https://directory.example");
    vi.stubEnv("WINDOWS_API_TOKEN", "private-api-token");
    vi.resetModules();
    resetDb();
    ({ db } = await import("../db"));
    outbox = await import("./outbox");
    page = await import("./log-page");
    manual = await import("./manual-delivery");
    ({ drainOnce: drain } = await import("../../worker/provisioning"));
    const [schema] = await db
      .select()
      .from(tables.formSchemas)
      .where(eq(tables.formSchemas.formKey, "signup"))
      .limit(1);
    schemaId = schema!.id;
    await db
      .insert(tables.user)
      .values({ id: actorId, name: "Reviewer", email: "reviewer@example.com" });
  });
  beforeEach(async () => {
    mail.mockReset().mockResolvedValue(undefined);
    await db.delete(tables.provisioningEvents);
    await db.delete(tables.signupSubmissions);
  });
  afterAll(async () => {
    await globalThis.__pgliteClient?.close();
    resetDb();
    vi.unstubAllEnvs();
  });
  async function request(mode: "email" | "admin" = "email") {
    const username = `applicant-${crypto.randomUUID()}`;
    const [signup] = await db
      .insert(tables.signupSubmissions)
      .values({
        schemaVersionId: schemaId,
        firstName: "Alex",
        lastName: "Smith",
        netid: username,
        username,
        email: `${username}@example.com`,
        uin: "987654321",
        answers: {},
        status: "approved",
      })
      .returning();
    const id = crypto.randomUUID();
    await db.transaction((tx) =>
      outbox.enqueueProvisioning(tx, signup!, id, mode),
    );
    return { id, username, signup: signup! };
  }
  function url(id?: string, query = "") {
    return new URL(
      `https://portal.example/dashboard/admin/provisioning/?${id ? `event=${id}&` : ""}${query}`,
    );
  }
  function response(username: string, password = "one-time-secret") {
    return new Response(
      JSON.stringify({
        samAccountName: username,
        existed: false,
        oneTimePassword: password,
      }),
    );
  }

  it("retains timestamped failure history across a retry and successful credential delivery", async () => {
    const { id, username } = await request();
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await drain(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(
              JSON.stringify({
                error: "AD create failed: Access is denied.\r\n",
              }),
              { status: 502 },
            ),
          ),
      );
      const failed = await page.readProvisioningPage(url(id));
      expect(failed.selected).toMatchObject({
        status: "failed",
        attempts: 1,
        lastError: "Provisioning API 502: AD create failed: Access is denied.",
      });
      expect(failed.selected!.nextAttemptAt).toBeTruthy();
      expect(failed.logs.map((entry) => entry.kind)).toEqual([
        "failed",
        "started",
        "queued",
      ]);
      for (const entry of failed.logs)
        expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
      await outbox.retryProvisioning(id);
      await drain(vi.fn<typeof fetch>().mockResolvedValue(response(username)));
      const completed = await page.readProvisioningPage(url(id));
      expect(completed.selected).toMatchObject({
        status: "provisioned",
        lastError: null,
        nextAttemptAt: null,
      });
      expect(completed.logs.map((entry) => entry.kind)).toEqual([
        "provisioned",
        "credentials_delivered",
        "credentials_pending",
        "started",
        "retry_requested",
        "failed",
        "started",
        "queued",
      ]);
      expect(
        completed.logs.find((entry) => entry.kind === "failed")!.error,
      ).toContain("Access is denied");
      const persisted = await db.select().from(tables.provisioningLogs);
      expect(
        JSON.stringify([
          persisted,
          completed,
          output.mock.calls,
          errors.mock.calls,
        ]),
      ).not.toContain("one-time-secret");
      expect(JSON.stringify(completed)).not.toContain("987654321");
      expect(JSON.stringify(completed)).not.toContain("claimToken");
      const emittedError = JSON.parse(String(errors.mock.calls[0]![0]));
      expect(emittedError).toMatchObject({
        eventId: id,
        kind: "failed",
        attempt: 1,
      });
      expect(new Date(emittedError.timestamp).toISOString()).toBe(
        emittedError.timestamp,
      );
    } finally {
      output.mockRestore();
      errors.mockRestore();
    }
  });

  it("redacts issued credentials and configured secrets from delivery failures", async () => {
    const { id, username } = await request();
    mail.mockImplementation(
      ({ oneTimePassword }: { oneTimePassword: string }) => {
        throw new Error(
          `SMTP failed with ${oneTimePassword} and private-api-token`,
        );
      },
    );
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await drain(vi.fn<typeof fetch>().mockResolvedValue(response(username)));
      const data = await page.readProvisioningPage(url(id));
      expect(data.selected!.lastError).toBe(
        "SMTP failed with [redacted] and [redacted]",
      );
      const [event] = await db
        .select()
        .from(tables.provisioningEvents)
        .where(eq(tables.provisioningEvents.id, id));
      const logs = await db.select().from(tables.provisioningLogs);
      const diagnostics = JSON.stringify([
        event!.lastError,
        logs,
        data,
        errors.mock.calls,
      ]);
      expect(diagnostics).not.toContain("one-time-secret");
      expect(diagnostics).not.toContain("private-api-token");
    } finally {
      errors.mockRestore();
    }
  });

  it("does not record stale workers completing or failing a newer claim", async () => {
    const { id } = await request();
    const old = await outbox.claimNext();
    await db
      .update(tables.provisioningEvents)
      .set({ updatedAt: new Date(0) })
      .where(eq(tables.provisioningEvents.id, id));
    const current = await outbox.claimNext();
    expect(current!.claimToken).not.toBe(old!.claimToken);
    expect(await outbox.markFailed(old!, "stale failure", 1)).toBe(false);
    expect(await outbox.markProvisioned(old!)).toBe(false);
    expect(await outbox.markCredentialDelivery(old!, "delivered")).toBe(false);
    const history = (await page.readProvisioningPage(url(id))).logs;
    expect(history.map((entry) => entry.kind)).toEqual([
      "started",
      "started",
      "queued",
    ]);
    expect(JSON.stringify(history)).not.toContain("stale failure");
    await outbox.markFailed(current!, "max attempts", 10);
    expect((await page.readProvisioningPage(url(id))).selected).toMatchObject({
      status: "dead_lettered",
      nextAttemptAt: null,
    });
  });

  it("records manual failures, fresh attempts, and confirmation without revealing credentials", async () => {
    const { id, username } = await request("admin");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        manual.revealManualCredentials(
          id,
          actorId,
          vi
            .fn<typeof fetch>()
            .mockRejectedValue(new Error("AD access denied")),
        ),
      ).rejects.toMatchObject({ status: 502 });
      const credentials = await manual.revealManualCredentials(
        id,
        actorId,
        vi.fn<typeof fetch>().mockResolvedValue(response(username)),
      );
      expect(
        await manual.confirmManualDelivery(id, crypto.randomUUID(), actorId),
      ).toBe(false);
      expect(
        await manual.confirmManualDelivery(id, credentials.token, actorId),
      ).toBe(true);
      const data = await page.readProvisioningPage(url(id));
      expect(data.logs.map((entry) => entry.kind)).toEqual([
        "provisioned",
        "credentials_ready",
        "started",
        "failed",
        "started",
        "queued",
      ]);
      expect(JSON.stringify(data)).not.toContain(credentials.oneTimePassword);
      expect(JSON.stringify(data)).not.toContain(credentials.token);
      expect(mail).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("rolls back the state change if its history cannot be persisted", async () => {
    const { id } = await request();
    const claim = await outbox.claimNext();
    const module = await import("./logs");
    const failure = vi
      .spyOn(module, "recordProvisioningLog")
      .mockRejectedValueOnce(new Error("history unavailable"));
    try {
      await expect(outbox.markFailed(claim!, "AD denied", 1)).rejects.toThrow(
        "history unavailable",
      );
      const [event] = await db
        .select()
        .from(tables.provisioningEvents)
        .where(eq(tables.provisioningEvents.id, id));
      expect(event).toMatchObject({
        status: "processing",
        lastError: null,
        attempts: 0,
      });
    } finally {
      failure.mockRestore();
    }
  });

  it("paginates requests and history, filters literally, and exposes legacy errors without invented history", async () => {
    const { id, signup } = await request();
    await db.insert(tables.provisioningEvents).values(
      Array.from({ length: 25 }, (_, i) => ({
        submissionId: signup.id,
        status: i === 0 ? ("failed" as const) : ("provisioned" as const),
        payload: { oneTimePassword: "payload-must-stay-private" },
        updatedAt: new Date(Date.UTC(2026, 9, 7, 15, 0, i)),
        lastError:
          i === 0
            ? 'Provisioning API 502: {"error":"AD denied","token":"private-api-token"}'
            : null,
      })),
    );
    const first = await page.readProvisioningPage(url());
    const second = await page.readProvisioningPage(url(undefined, "page=2"));
    expect(first.rows).toHaveLength(25);
    expect(first.hasNext).toBe(true);
    expect(second.rows).toHaveLength(1);
    expect(second.hasNext).toBe(false);
    expect(
      new Set([...first.rows, ...second.rows].map((row) => row.id)).size,
    ).toBe(26);
    const filtered = await page.readProvisioningPage(
      url(undefined, "status=failed&q=alex"),
    );
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]!.lastError).toBe("Provisioning API 502: AD denied");
    expect(
      (await page.readProvisioningPage(url(filtered.rows[0]!.id))).logs,
    ).toEqual([]);
    expect(
      (await page.readProvisioningPage(url(undefined, "q=%25"))).rows,
    ).toEqual([]);
    expect(
      await page.readProvisioningPage(url(undefined, "page=-1&status=invalid")),
    ).toMatchObject({ page: 1, status: "" });
    expect(
      await page.readProvisioningPage(url(undefined, "event=not-a-uuid")),
    ).toMatchObject({ selected: null, selectedRequested: true });
    expect(JSON.stringify(first)).not.toContain("payload-must-stay-private");
    await db
      .delete(tables.provisioningLogs)
      .where(eq(tables.provisioningLogs.eventId, id));
    await db.insert(tables.provisioningLogs).values(
      Array.from({ length: 51 }, (_, i) => ({
        eventId: id,
        kind: "started" as const,
        message: "Attempt started.",
        createdAt: new Date(Date.UTC(2026, 9, 7, 16, 0, i)),
      })),
    );
    const recent = await page.readProvisioningPage(url(id));
    const older = await page.readProvisioningPage(url(id, "logPage=2"));
    expect(recent.logs).toHaveLength(50);
    expect(recent.hasOlderLogs).toBe(true);
    expect(older.logs).toHaveLength(1);
    expect(older.hasOlderLogs).toBe(false);
    expect(
      new Set([...recent.logs, ...older.logs].map((entry) => entry.id)).size,
    ).toBe(51);
  });
});
