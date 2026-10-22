import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { PortalDb } from "../db";
import {
  accountActivations,
  provisioningEvents,
  signupSubmissions,
} from "../db/schema";
import {
  activationRejected,
  activationUnconfirmed,
  type ActivationResult,
} from "../activation-response";

export type ActivationInput = {
  username: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};
export type ActivationServerResult = ActivationResult & { status: number };
export const activationUnavailable =
  "Activation is unavailable. Contact ACM support.";

/** Shared SQL counters serialize concurrent requests from every portal replica. */
export async function consumeActivationAttempt(
  db: PortalDb,
  username: string,
  address: string,
): Promise<boolean> {
  const keys = [
    {
      key: `username:${createHash("sha256").update(username).digest("hex")}`,
      max: 5,
    },
    {
      key: `address:${createHash("sha256").update(address).digest("hex")}`,
      max: 100,
    },
  ].sort((a, b) => a.key.localeCompare(b.key));
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`DELETE FROM account_activation_limits WHERE window_start < now() - interval '1 day'`,
    );
    for (const { key, max } of keys) {
      const rows = await tx.execute(sql`
        INSERT INTO account_activation_limits (key, attempts, window_start)
        VALUES (${key}, 1, now())
        ON CONFLICT (key) DO UPDATE SET
          attempts = CASE WHEN account_activation_limits.window_start <= now() - interval '15 minutes' THEN 1 ELSE account_activation_limits.attempts + 1 END,
          window_start = CASE WHEN account_activation_limits.window_start <= now() - interval '15 minutes' THEN now() ELSE account_activation_limits.window_start END
        RETURNING attempts`);
      // Address sorts first: a blocked client cannot grow rows by rotating usernames.
      if (Number(rows.rows[0]?.attempts) > max) return false;
    }
    return true;
  });
}

/** One attempt only. Even malformed success replies may follow an applied AD change. */
export async function activateInAd(
  input: ActivationInput,
  eventId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ActivationServerResult> {
  const base = process.env.WINDOWS_API_URL;
  const token = process.env.WINDOWS_API_TOKEN;
  let url: URL;
  try {
    if (!base || !token) throw new Error();
    url = new URL(
      `${base.replace(/\/$/, "")}/users/${encodeURIComponent(input.username)}/activate`,
    );
    if (!["https:", "http:"].includes(url.protocol)) throw new Error();
  } catch {
    return { ok: false, status: 503, error: activationUnavailable };
  }
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        eventId,
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
      }),
    });
    if (response.status === 200) {
      const body: unknown = await response.json();
      if (
        body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        "ok" in body &&
        body.ok === true
      )
        return { ok: true, status: 200 };
    }
    // Only explicit pre-change rejection is safe to retry. Never echo upstream details.
    if ([400, 404, 409].includes(response.status))
      return { ok: false, status: 400, error: activationRejected };
    if ([401, 403, 429].includes(response.status))
      return { ok: false, status: 503, error: activationUnavailable };
  } catch {
    /* Never log an exception carrying passwords, and never retry. */
  }
  return {
    ok: false,
    status: 502,
    error: activationUnconfirmed,
    uncertain: true,
  };
}

export async function activateAccount(
  db: PortalDb,
  input: ActivationInput,
  address: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ActivationServerResult> {
  try {
    if (!(await consumeActivationAttempt(db, input.username, address)))
      return {
        ok: false,
        status: 429,
        error:
          "Too many activation attempts. Wait 15 minutes before trying again.",
      };
  } catch {
    return { ok: false, status: 503, error: activationUnavailable };
  }
  try {
    return await db.transaction(async (tx) => {
      // Lock the owning event through the AD call and receipt to serialize duplicate activations.
      const [event] = await tx
        .select({
          id: provisioningEvents.id,
          username: signupSubmissions.username,
        })
        .from(provisioningEvents)
        .innerJoin(
          signupSubmissions,
          eq(signupSubmissions.id, provisioningEvents.submissionId),
        )
        .leftJoin(
          accountActivations,
          eq(accountActivations.eventId, provisioningEvents.id),
        )
        .where(
          and(
            sql`lower(${signupSubmissions.username}) = ${input.username}`,
            eq(signupSubmissions.status, "approved"),
            eq(provisioningEvents.status, "provisioned"),
            eq(provisioningEvents.credentialDeliveryStatus, "delivered"),
            isNull(accountActivations.eventId),
          ),
        )
        .orderBy(sql`${provisioningEvents.createdAt} DESC`)
        .limit(1)
        .for("update", { of: provisioningEvents });
      if (!event) return { ok: false, status: 400, error: activationRejected };
      const result = await activateInAd(
        { ...input, username: event.username },
        event.id,
        fetchImpl,
      );
      if (result.ok)
        await tx.insert(accountActivations).values({ eventId: event.id });
      return result;
    });
  } catch {
    // A failed receipt commit could follow a successful AD change.
    return {
      ok: false,
      status: 502,
      error: activationUnconfirmed,
      uncertain: true,
    };
  }
}
