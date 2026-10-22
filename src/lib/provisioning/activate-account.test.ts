import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { PortalDb } from "../db";
import {
  activationRejected,
  activationUnconfirmed,
} from "../activation-response";
import {
  activateAccount,
  activateInAd,
  consumeActivationAttempt,
} from "./activate-account";

const id = "00000000-0000-0000-0000-000000000001";
const input = {
  username: "newmember",
  currentPassword: " temporary secret ",
  newPassword: " new secret ",
  confirmPassword: " new secret ",
};

describe("initial account activation", () => {
  let client: PGlite;
  let db: PortalDb;
  beforeAll(async () => {
    client = new PGlite();
    await client.exec(`
      CREATE TABLE signup_submissions (id uuid PRIMARY KEY, username text NOT NULL, status text NOT NULL);
      CREATE TABLE provisioning_events (id uuid PRIMARY KEY, submission_id uuid NOT NULL, status text NOT NULL, credential_delivery_status text, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE account_activations (event_id uuid PRIMARY KEY REFERENCES provisioning_events(id) ON DELETE CASCADE, activated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE account_activation_limits (key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL);
    `);
    db = drizzle(client) as unknown as PortalDb;
  });
  afterAll(async () => client.close());
  beforeEach(async () => {
    vi.stubEnv("WINDOWS_API_URL", "https://directory.example");
    vi.stubEnv("WINDOWS_API_TOKEN", "api-token");
    await client.exec(
      "TRUNCATE account_activations, provisioning_events, signup_submissions, account_activation_limits CASCADE",
    );
    await client.query(
      "INSERT INTO signup_submissions VALUES ($1, 'NewMember', 'approved')",
      [id],
    );
    await client.query(
      "INSERT INTO provisioning_events (id, submission_id, status, credential_delivery_status) VALUES ($1, $1, 'provisioned', 'delivered')",
      [id],
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it("changes a delivered approved account once and stores only a receipt", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ ok: true }));
    expect(await activateAccount(db, input, "192.0.2.1", send)).toEqual({
      ok: true,
      status: 200,
    });
    expect(String(send.mock.calls[0][0])).toBe(
      "https://directory.example/users/NewMember/activate",
    );
    expect(JSON.parse(send.mock.calls[0][1]!.body as string)).toEqual({
      eventId: id,
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
    });
    const receipt = (await client.query("SELECT * FROM account_activations"))
      .rows;
    expect(receipt).toHaveLength(1);
    expect(Object.keys(receipt[0] as object)).toEqual([
      "event_id",
      "activated_at",
    ]);
    expect(await activateAccount(db, input, "192.0.2.1", send)).toEqual({
      ok: false,
      status: 400,
      error: activationRejected,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    "UPDATE signup_submissions SET status = 'pending'",
    "UPDATE signup_submissions SET status = 'denied'",
    "UPDATE provisioning_events SET status = 'processing'",
    "UPDATE provisioning_events SET credential_delivery_status = 'pending'",
    "UPDATE provisioning_events SET credential_delivery_status = NULL",
    "DELETE FROM provisioning_events",
    "UPDATE signup_submissions SET username = 'anothermember'",
  ])("rejects ineligible accounts generically: %s", async (update) => {
    await client.exec(update);
    const send = vi.fn<typeof fetch>();
    expect(await activateAccount(db, input, "192.0.2.1", send)).toEqual({
      ok: false,
      status: 400,
      error: activationRejected,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("does not persist a receipt for AD credential or password policy rejection", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ error: input.currentPassword }, { status: 400 }),
      );
    expect(await activateAccount(db, input, "192.0.2.1", send)).toEqual({
      ok: false,
      status: 400,
      error: activationRejected,
    });
    expect(
      (await client.query("SELECT * FROM account_activations")).rows,
    ).toEqual([]);
  });

  it("shares username throttling across independent addresses and never stores plaintext identifiers", async () => {
    for (let n = 0; n < 5; n++)
      expect(await consumeActivationAttempt(db, "member", `address-${n}`)).toBe(
        true,
      );
    expect(await consumeActivationAttempt(db, "member", "new-address")).toBe(
      false,
    );
    const rows = (await client.query("SELECT * FROM account_activation_limits"))
      .rows;
    expect(JSON.stringify(rows)).not.toContain("member");
    expect(JSON.stringify(rows)).not.toContain("new-address");
    await client.exec(
      "UPDATE account_activation_limits SET window_start = now() - interval '16 minutes'",
    );
    expect(await consumeActivationAttempt(db, "member", "new-address")).toBe(
      true,
    );
  });

  it("shares an address budget across usernames", async () => {
    // Exercise the real limit with distinct usernames, as attackers can rotate names.
    for (let n = 0; n < 100; n++)
      expect(
        await consumeActivationAttempt(db, `user-${n}`, "same-address"),
      ).toBe(true);
    expect(
      await consumeActivationAttempt(db, "fresh-user", "same-address"),
    ).toBe(false);
  });

  it.each([
    "<html>private details</html>",
    '{"ok":false}',
    '{"ok":"true"}',
    "null",
    "[]",
  ])("never retries an unconfirmed response %s", async (body) => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    expect(await activateInAd(input, id, send)).toEqual({
      ok: false,
      status: 502,
      error: activationUnconfirmed,
      uncertain: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not retry exceptions or expose their text", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error(input.currentPassword));
    expect(await activateInAd(input, id, send)).toEqual({
      ok: false,
      status: 502,
      error: activationUnconfirmed,
      uncertain: true,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["", "ftp://directory.example", "invalid"])(
    "fails closed with invalid configuration %s",
    async (base) => {
      vi.stubEnv("WINDOWS_API_URL", base);
      const send = vi.fn<typeof fetch>();
      expect(await activateInAd(input, id, send)).toMatchObject({
        ok: false,
        status: 503,
      });
      expect(send).not.toHaveBeenCalled();
    },
  );
});
