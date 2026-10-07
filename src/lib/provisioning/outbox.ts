import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { provisioningEvents, type signupSubmissions } from "../db/schema.ts";
import { formatSignupDisplayName, companyForCollege } from "../forms/fields.ts";
import { nextDelayMs, isDeadLettered } from "./backoff.ts";

export type DbOrTx = Pick<
	typeof db,
	"insert" | "update" | "execute" | "select"
>;
type Submission = typeof signupSubmissions.$inferSelect;
export type ProvisioningEvent = typeof provisioningEvents.$inferSelect;
export type ProvisioningClaim = Pick<ProvisioningEvent, "id"> & {
	claimToken: string;
};
export type ClaimedProvisioningEvent = ProvisioningEvent & ProvisioningClaim;

/**
 * Enqueue inside the APPROVAL transaction — approval and outbox insert commit
 * or roll back together (approved signups can never be lost).
 */
export async function enqueueProvisioning(
	tx: DbOrTx,
	submission: Submission,
	eventId: string,
	credentialDeliveryMode: "email" | "admin" = "email",
): Promise<void> {
	await tx.insert(provisioningEvents).values({
		id: eventId,
		submissionId: submission.id,
		credentialDeliveryMode,
		...(credentialDeliveryMode === "admin"
			? { credentialDeliveryStatus: "pending" as const }
			: {}),
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
function toEvent(row: Record<string, unknown>): ClaimedProvisioningEvent {
	return {
		id: row.id,
		submissionId: row.submission_id,
		payload: row.payload,
		status: row.status,
		attempts: row.attempts,
		claimToken: row.claim_token,
		credentialDeliveryStatus: row.credential_delivery_status,
		credentialDeliveryMode: row.credential_delivery_mode,
		credentialRevealToken: row.credential_reveal_token,
		nextAttemptAt: row.next_attempt_at,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	} as ClaimedProvisioningEvent;
}

/** Atomically claim the next due event (multi-replica safe).
    Also reclaims events stuck in 'processing' > 5 min after a worker crash;
    reclaim increments attempts so crash-loops converge to dead-letter.
    API requests and SMTP waits have timeouts; persisted delivery receipts
    prevent completed delivery from being repeated after a reclaim. */
export async function claimNext(): Promise<ClaimedProvisioningEvent | null> {
	const token = crypto.randomUUID();
	const { rows } = await db.execute<Record<string, unknown>>(sql`
    UPDATE provisioning_events
    SET status = 'processing', claim_token = ${token}::uuid,
        attempts = CASE WHEN status = 'processing' THEN attempts + 1 ELSE attempts END,
        updated_at = now()
    WHERE id = (
      SELECT id FROM provisioning_events
      WHERE credential_delivery_mode = 'email' AND (
        (status IN ('pending', 'failed') AND next_attempt_at <= now())
        OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
      )
      ORDER BY next_attempt_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);
	const row = rows[0];
	return row ? toEvent(row) : null;
}

function ownedClaim(event: ProvisioningClaim) {
	return and(
		eq(provisioningEvents.id, event.id),
		eq(provisioningEvents.status, "processing"),
		eq(provisioningEvents.claimToken, event.claimToken),
	);
}

/** Lock each external operation against reclamation, and reject expired claims. */
export async function withProvisioningClaim<T>(
	event: ProvisioningClaim,
	operation: (tx: DbOrTx) => Promise<T>,
): Promise<{ owned: true; value: T } | { owned: false }> {
	return db.transaction(async (tx) => {
		const { rows } = await tx.execute(sql`
      SELECT id FROM provisioning_events
      WHERE id = ${event.id}::uuid AND status = 'processing'
        AND claim_token = ${event.claimToken}::uuid
      FOR UPDATE
    `);
		if (!rows.length) return { owned: false };
		return { owned: true, value: await operation(tx) };
	});
}

export async function markProvisioned(
	event: ProvisioningClaim,
): Promise<boolean> {
	const updated = await db
		.update(provisioningEvents)
		.set({ status: "provisioned", updatedAt: new Date() })
		.where(ownedClaim(event))
		.returning({ id: provisioningEvents.id });
	return updated.length > 0;
}

/** Save progress so a restart cannot skip failed mail or reset delivered credentials. */
export async function markCredentialDelivery(
	event: ProvisioningClaim,
	status: "pending" | "delivered",
	client: DbOrTx = db,
): Promise<boolean> {
	const updated = await client
		.update(provisioningEvents)
		.set({ credentialDeliveryStatus: status, updatedAt: new Date() })
		.where(ownedClaim(event))
		.returning({ id: provisioningEvents.id });
	return updated.length > 0;
}

export async function markFailed(
	event: ProvisioningClaim,
	error: string,
	attempts: number,
): Promise<boolean> {
	const updated = await db
		.update(provisioningEvents)
		.set({
			status: isDeadLettered(attempts) ? "dead_lettered" : "failed",
			attempts,
			lastError: error.slice(0, 2000),
			nextAttemptAt: new Date(Date.now() + nextDelayMs(attempts - 1)),
			updatedAt: new Date(),
		})
		.where(ownedClaim(event))
		.returning({ id: provisioningEvents.id });
	return updated.length > 0;
}

/** Retry failed work atomically without resetting a live or completed event. */
export async function retryProvisioning(id: string): Promise<boolean> {
	const retried = await db
		.update(provisioningEvents)
		.set({
			status: "pending",
			claimToken: null,
			attempts: 0,
			nextAttemptAt: new Date(),
			lastError: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(provisioningEvents.id, id),
				eq(provisioningEvents.credentialDeliveryMode, "email"),
				inArray(provisioningEvents.status, ["failed", "dead_lettered"]),
			),
		)
		.returning({ id: provisioningEvents.id });
	return retried.length > 0;
}
