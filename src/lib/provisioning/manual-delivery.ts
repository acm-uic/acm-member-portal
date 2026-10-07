import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditEvents, provisioningEvents } from "../db/schema";
import { provisionAccount, seedLocalMemberLogin } from "./account";
import { recordProvisioningLog, emitProvisioningLog } from "./logs";
import { sanitizeProvisioningError } from "./diagnostics";

export class ManualDeliveryError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** The password travels directly to the admin response, never through the outbox or loaders. */
export async function revealManualCredentials(
  id: string,
  actorId: string,
  fetchImpl: typeof fetch = fetch,
) {
  const token = crypto.randomUUID();
  // Claim before touching AD. Manual events are never claimed by the email worker.
  // Replace the receipt on every attempt so an older password cannot be acknowledged.
  const started = await db.transaction(async (tx) => {
    const { rows } = await tx.execute<{ id: string; attempts: number }>(sql`
    UPDATE provisioning_events AS event
    SET status = 'processing', credential_reveal_token = ${token}::uuid,
        attempts = attempts + 1, updated_at = now(), last_error = NULL
    WHERE event.id = ${id}::uuid AND credential_delivery_mode = 'admin'
      AND credential_delivery_status = 'pending'
      AND (status IN ('pending', 'failed', 'dead_lettered')
        OR (status = 'processing' AND updated_at < now() - interval '5 minutes'))
      AND EXISTS (SELECT 1 FROM signup_submissions AS signup
        WHERE signup.id = event.submission_id AND signup.status = 'approved')
      AND NOT EXISTS (SELECT 1 FROM provisioning_events AS completed
        WHERE completed.submission_id = event.submission_id AND completed.status = 'provisioned')
    RETURNING event.id, event.attempts
  `);
    if (!rows.length)
      throw new ManualDeliveryError(
        "This account is being created or is no longer available for manual delivery. Refresh its status.",
        409,
      );
    return recordProvisioningLog(tx, {
      eventId: id,
      kind: "started",
      attempt: rows[0]!.attempts,
      message: "Manual provisioning attempt started.",
    });
  });
  emitProvisioningLog(started);

  const ownedAttempt = and(
    eq(provisioningEvents.id, id),
    eq(provisioningEvents.status, "processing"),
    eq(provisioningEvents.credentialRevealToken, token),
  );
  let password: string | undefined;
  try {
    const [event] = await db
      .select()
      .from(provisioningEvents)
      .where(ownedAttempt);
    if (!event)
      throw new Error("Manual credential attempt no longer owns this event.");
    const { payload, username, body } = await provisionAccount(
      event,
      fetchImpl,
    );
    if (!body.oneTimePassword)
      throw new Error(
        "AD account exists, but the provisioning API could not reissue this signup's temporary credentials. An administrator must verify the account before retrying.",
      );
    password = body.oneTimePassword;
    if (!process.env.WINDOWS_API_URL) {
      await seedLocalMemberLogin({
        email: payload.email,
        name: payload.displayName,
        password: body.oneTimePassword,
        netid: payload.netid,
        username,
        uin: payload.uin,
        firstName: payload.firstName,
        lastName: payload.lastName,
        preferredName: payload.preferredName,
        reissue: true,
      });
    }
    const ready = await db.transaction(async (tx) => {
      const updated = await tx
        .update(provisioningEvents)
        .set({ status: "pending", updatedAt: new Date() })
        .where(ownedAttempt)
        .returning({ id: provisioningEvents.id });
      if (!updated.length) return false;
      await tx.insert(auditEvents).values({
        actorId,
        action: "signup.credentials_reveal",
        targetType: "provisioning_event",
        targetId: id,
        after: { username },
      });
      await recordProvisioningLog(tx, {
        eventId: id,
        kind: "credentials_ready",
        attempt: event.attempts,
        message:
          "Temporary credentials are ready for administrator confirmation.",
      });
      return true;
    });
    if (!ready)
      throw new Error(
        "Manual credential attempt was replaced. Request a new password.",
      );
    return {
      ok: true as const,
      username: body.samAccountName,
      oneTimePassword: body.oneTimePassword,
      token,
    };
  } catch (error) {
    const safeError = sanitizeProvisioningError(
      error instanceof Error ? error.message : "Manual account setup failed.",
      [password],
    );
    const entry = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(provisioningEvents)
        .set({ status: "failed", lastError: safeError, updatedAt: new Date() })
        .where(ownedAttempt)
        .returning({ attempts: provisioningEvents.attempts });
      if (!updated) return null;
      return recordProvisioningLog(tx, {
        eventId: id,
        kind: "failed",
        attempt: updated.attempts,
        error: safeError,
        message:
          "Manual account setup failed; administrator action is required.",
      });
    });
    if (entry) emitProvisioningLog(entry);
    throw new ManualDeliveryError(
      "Account setup failed. Refresh status for details and try again.",
      502,
    );
  }
}

/** Only acknowledge the current reveal, after its password reached the admin. */
export async function confirmManualDelivery(
  id: string,
  token: string,
  actorId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(provisioningEvents)
      .set({
        status: "provisioned",
        credentialDeliveryStatus: "delivered",
        credentialRevealToken: null,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(provisioningEvents.id, id),
          eq(provisioningEvents.credentialDeliveryMode, "admin"),
          eq(provisioningEvents.status, "pending"),
          eq(provisioningEvents.credentialDeliveryStatus, "pending"),
          eq(provisioningEvents.credentialRevealToken, token),
        ),
      )
      .returning({
        id: provisioningEvents.id,
        attempts: provisioningEvents.attempts,
      });
    if (!updated.length) return false;
    await tx.insert(auditEvents).values({
      actorId,
      action: "signup.credentials_copied",
      targetType: "provisioning_event",
      targetId: id,
    });
    await recordProvisioningLog(tx, {
      eventId: id,
      kind: "provisioned",
      attempt: updated[0]!.attempts,
      message:
        "Administrator confirmed credential delivery; account setup completed.",
    });
    return true;
  });
}
