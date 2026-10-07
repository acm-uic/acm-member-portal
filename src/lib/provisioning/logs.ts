import { provisioningLogs } from "../db/schema.ts";
import type { DbOrTx } from "./outbox.ts";
import { sanitizeProvisioningError } from "./diagnostics.ts";

type LogInput = Omit<
  typeof provisioningLogs.$inferInsert,
  "id" | "sequence" | "createdAt"
>;

/** Write history in the same transaction as the event's state change. */
export async function recordProvisioningLog(client: DbOrTx, input: LogInput) {
  const [entry] = await client
    .insert(provisioningLogs)
    .values({
      ...input,
      error: input.error ? sanitizeProvisioningError(input.error) : null,
      createdAt: new Date(),
    })
    .returning();
  return entry!;
}

/** Emit only committed transitions; do not serialize account payloads or claim tokens. */
export function emitProvisioningLog(
  entry: typeof provisioningLogs.$inferSelect,
) {
  const output = JSON.stringify({
    timestamp: entry.createdAt.toISOString(),
    eventId: entry.eventId,
    kind: entry.kind,
    attempt: entry.attempt,
    message: entry.message,
    error: entry.error,
  });
  if (entry.error) console.error(output);
  else console.info(output);
}
