import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
  formSchemas,
  provisioningEvents,
  signupSubmissions,
} from "../db/schema";
import { duplicateSignupNetid } from "./duplicates";

/** Approval stays visible until the worker records successful provisioning. */
export const signupQueueCondition = sql`
  ${signupSubmissions.status} = 'pending' OR (
    ${signupSubmissions.status} = 'approved' AND NOT EXISTS (
      SELECT 1 FROM provisioning_events AS completed_event
      WHERE completed_event.submission_id = ${signupSubmissions.id}
        AND completed_event.status = 'provisioned'
    )
  )
`;

export async function loadSignupQueue(
  includeRestricted: boolean,
  limit = 50,
  offset = 0,
) {
  const latestEvent = db
    .selectDistinctOn([provisioningEvents.submissionId], {
      submissionId: provisioningEvents.submissionId,
      id: provisioningEvents.id,
      status: provisioningEvents.status,
      lastError: provisioningEvents.lastError,
      credentialDeliveryMode: provisioningEvents.credentialDeliveryMode,
      updatedAt: provisioningEvents.updatedAt,
      nextAttemptAt: provisioningEvents.nextAttemptAt,
    })
    .from(provisioningEvents)
    .orderBy(
      provisioningEvents.submissionId,
      desc(provisioningEvents.createdAt),
      desc(provisioningEvents.id),
    )
    .as("latest_provisioning_event");

  return db
    .select({
      id: signupSubmissions.id,
      status: signupSubmissions.status,
      firstName: signupSubmissions.firstName,
      lastName: signupSubmissions.lastName,
      preferredName: signupSubmissions.preferredName,
      netid: signupSubmissions.netid,
      duplicateNetid: duplicateSignupNetid,
      username: signupSubmissions.username,
      email: signupSubmissions.email,
      discordId: signupSubmissions.discordId,
      discordUsername: signupSubmissions.discordUsername,
      discordInGuild: signupSubmissions.discordInGuild,
      answers: signupSubmissions.answers,
      schemaDefinition: formSchemas.fields,
      createdAt: signupSubmissions.createdAt,
      provisioningId: latestEvent.id,
      provisioningStatus: latestEvent.status,
      provisioningError: latestEvent.lastError,
      credentialDeliveryMode: latestEvent.credentialDeliveryMode,
      provisioningUpdatedAt: latestEvent.updatedAt,
      nextAttemptAt: latestEvent.nextAttemptAt,
      ...(includeRestricted ? { uin: signupSubmissions.uin } : {}),
    })
    .from(signupSubmissions)
    .leftJoin(
      formSchemas,
      eq(signupSubmissions.schemaVersionId, formSchemas.id),
    )
    .leftJoin(latestEvent, eq(signupSubmissions.id, latestEvent.submissionId))
    .where(signupQueueCondition)
    .orderBy(desc(signupSubmissions.createdAt), desc(signupSubmissions.id))
    .limit(limit)
    .offset(offset);
}

export function provisioningErrorText(error: string | null): string | null {
  if (!error) return null;
  // Extract the API's message so officers do not see JSON or AD's NUL padding.
  const response = /^Provisioning API \d+: (.*)$/s.exec(error);
  if (response) {
    try {
      const body = JSON.parse(response[1]);
      if (typeof body?.error === "string")
        return body.error.replace(/\0/g, "").trim();
    } catch {
      // Older worker versions truncate JSON before removing AD's NUL padding.
      const message =
        /"error"\s*:\s*"((?:\\(?:["\\/bfnrt]|u[\da-fA-F]{4})|[^"\\])*)/.exec(
          response[1],
        );
      if (message) {
        try {
          return JSON.parse(`"${message[1]}"`).replace(/\0/g, "").trim();
        } catch {
          // Preserve diagnostics from an invalid response rather than hiding them.
        }
      }
    }
  }
  return error.replace(/\0|\\u0000/g, "").trim();
}
