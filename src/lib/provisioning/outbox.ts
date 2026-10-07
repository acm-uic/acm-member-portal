import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { provisioningEvents, type signupSubmissions } from "../db/schema.ts";
import { formatSignupDisplayName, companyForCollege } from "../forms/fields.ts";
import { nextDelayMs, isDeadLettered } from "./backoff.ts";

type DbOrTx = Pick<typeof db, "insert" | "update" | "execute" | "select">;
type Submission = typeof signupSubmissions.$inferSelect;
export type ProvisioningEvent = typeof provisioningEvents.$inferSelect;

/**
 * Enqueue inside the APPROVAL transaction — approval and outbox insert commit
 * or roll back together (approved signups can never be lost).
 */
export async function enqueueProvisioning(
	tx: DbOrTx,
	submission: Submission,
	eventId: string,
): Promise<void> {
	await tx.insert(provisioningEvents).values({
		id: eventId,
		submissionId: submission.id,
		payload: (() => {
			const answers = (submission.answers ?? {}) as Record<string, unknown>;
			const major =
				typeof answers.major === "string" && answers.major.trim()
					? answers.major.trim()
					: undefined;
			const college =
				typeof answers.college === "string" ? answers.college : undefined;
			return {
				netid: submission.netid,
				username: submission.username || submission.netid,
				firstName: submission.firstName,
				lastName: submission.lastName,
				preferredName: submission.preferredName?.trim() || undefined,
				displayName: formatSignupDisplayName({
					firstName: submission.firstName,
					lastName: submission.lastName,
					preferredName: submission.preferredName,
				}),
				email: submission.email,
				uin: submission.uin ?? undefined,
				department: major,
				company: companyForCollege(college),
				eventId,
			};
		})(),
	});
}

/** Map raw snake_case RETURNING rows onto the drizzle-inferred shape. */
function toEvent(row: Record<string, unknown>): ProvisioningEvent {
	return {
		id: row.id,
		submissionId: row.submission_id,
		payload: row.payload,
		status: row.status,
		attempts: row.attempts,
		credentialDeliveryStatus: row.credential_delivery_status,
		nextAttemptAt: row.next_attempt_at,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	} as ProvisioningEvent;
}

/** Atomically claim the next due event (multi-replica safe).
    Also reclaims events stuck in 'processing' > 5 min after a worker crash;
    reclaim increments attempts so crash-loops converge to dead-letter.
    API requests and SMTP waits have timeouts; persisted delivery receipts
    prevent completed delivery from being repeated after a reclaim. */
export async function claimNext(): Promise<ProvisioningEvent | null> {
	const { rows } = await db.execute<Record<string, unknown>>(sql`
    UPDATE provisioning_events
    SET status = 'processing',
        attempts = CASE WHEN status = 'processing' THEN attempts + 1 ELSE attempts END,
        updated_at = now()
    WHERE id = (
      SELECT id FROM provisioning_events
      WHERE (status IN ('pending', 'failed') AND next_attempt_at <= now())
         OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
      ORDER BY next_attempt_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
	const row = rows[0];
	return row ? toEvent(row) : null;
}

export async function markProvisioned(id: string): Promise<void> {
	await db
		.update(provisioningEvents)
		.set({ status: "provisioned", updatedAt: new Date() })
		.where(eq(provisioningEvents.id, id));
}

/** Save progress so a restart cannot skip failed mail or reset delivered credentials. */
export async function markCredentialDelivery(
	id: string,
	status: "pending" | "delivered",
): Promise<void> {
	await db
		.update(provisioningEvents)
		.set({ credentialDeliveryStatus: status, updatedAt: new Date() })
		.where(eq(provisioningEvents.id, id));
}

export async function markFailed(
	id: string,
	error: string,
	attempts: number,
): Promise<void> {
	await db
		.update(provisioningEvents)
		.set({
			status: isDeadLettered(attempts) ? "dead_lettered" : "failed",
			attempts,
			lastError: error.slice(0, 2000),
			nextAttemptAt: new Date(Date.now() + nextDelayMs(attempts - 1)),
			updatedAt: new Date(),
		})
		.where(eq(provisioningEvents.id, id));
}

/** Retry failed work atomically without resetting a live or completed event. */
export async function retryProvisioning(id: string): Promise<boolean> {
	const retried = await db
		.update(provisioningEvents)
		.set({
			status: "pending",
			attempts: 0,
			nextAttemptAt: new Date(),
			lastError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(provisioningEvents.id, id),
				inArray(provisioningEvents.status, ["failed", "dead_lettered"]),
			),
		)
		.returning({ id: provisioningEvents.id });
	return retried.length > 0;
}
