import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { provisioningEvents, type signupSubmissions } from "../db/schema";
import { formatSignupDisplayName, companyForCollege } from "../forms/fields";
import { nextDelayMs, isDeadLettered } from "./backoff";

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
		nextAttemptAt: row.next_attempt_at,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	} as ProvisioningEvent;
}

/** Atomically claim the next due event (multi-replica safe).
    Also reclaims events stuck in 'processing' > 5 min (worker crash mid-POST);
    reclaim increments attempts so crash-loops converge to dead-letter, and is
    safe because the worker's POST has a 30s timeout (nothing live at 5 min)
    and the API is idempotent on sAMAccountName. */
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

/** Officer-initiated retry from the admin panel. */
export async function retryDeadLetter(id: string): Promise<void> {
	await db
		.update(provisioningEvents)
		.set({
			status: "pending",
			attempts: 0,
			nextAttemptAt: new Date(),
			lastError: null,
			updatedAt: new Date(),
		})
		.where(eq(provisioningEvents.id, id));
}
