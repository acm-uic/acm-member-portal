import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { isEmbeddedDb } from "./db/mode.ts";
import {
  memberProfiles,
  provisioningEvents,
  signupSubmissions,
  user,
  userRoles,
} from "./db/schema.ts";
import { discordIdTaken, insertDiscordAccount } from "./discord-link.ts";
import { formatSignupDisplayName } from "./forms/fields.ts";

/** Serializes concurrent first logins (distinct from migrate.ts's lock id). */
const BOOTSTRAP_LOCK_ID = 727_002;

/** Seeded in drizzle/0000_initial.sql */
const ROLE_IDS = {
  member: "00000000-0000-0000-0000-000000000001",
  admin: "00000000-0000-0000-0000-000000000003",
} as const;

/**
 * Runs inside better-auth's databaseHooks.user.create.after.
 * Hook transactionality vs the user INSERT is undocumented, so this is
 * independently race-safe: an xact advisory lock serializes bootstrap checks
 * (skipped on single-process PGlite).
 *
 *  - First registered user (count == 1, the just-created row) → admin + member.
 *  - Everyone else → member.
 *  - Match an approved signup by username, or an unambiguous legacy NetID. Its answers
 *    seed the member_profiles row, and its provisioning event sets
 *    ad_provisioning_status (Slice 6: provisioning normally completes BEFORE
 *    first login — the AD account is the login precondition).
 */
export async function bootstrapUser(u: {
  id: string;
  email: string;
  netid: string | null;
  username?: string | null;
  displayName: string | null;
}) {
  await db.transaction(async (tx) => {
    if (!isEmbeddedDb()) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_ID})`);
    }

    const [{ count }] = (
      await tx.execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM "user"`,
      )
    ).rows;

    const grants =
      count === 1
        ? [
            { userId: u.id, roleId: ROLE_IDS.admin },
            { userId: u.id, roleId: ROLE_IDS.member },
          ]
        : [{ userId: u.id, roleId: ROLE_IDS.member }];

    await tx.insert(userRoles).values(grants).onConflictDoNothing();

    let answers: Record<string, unknown> = {};
    let answersSchemaVersionId: string | null = null;
    let adProvisioningStatus: "pending" | "provisioned" | "failed" = "pending";
    let provisionedAt: Date | null = null;

    if (u.username || u.netid) {
      const submissions = await tx
        .select()
        .from(signupSubmissions)
        .where(
          and(
            eq(signupSubmissions.status, "approved"),
            u.username
              ? eq(signupSubmissions.username, u.username)
              : eq(signupSubmissions.netid, u.netid!),
          ),
        )
        .orderBy(desc(signupSubmissions.createdAt))
        .limit(2);
      // Never choose another account's signup from an ambiguous shared NetID.
      const submission = u.username
        ? submissions[0]
        : submissions.length === 1
          ? submissions[0]
          : undefined;
      if (submission) {
        answers = submission.answers as Record<string, unknown>;
        answersSchemaVersionId = submission.schemaVersionId;

        const [event] = await tx
          .select()
          .from(provisioningEvents)
          .where(eq(provisioningEvents.submissionId, submission.id))
          .orderBy(desc(provisioningEvents.createdAt))
          .limit(1);

        if (event?.status === "provisioned") {
          adProvisioningStatus = "provisioned";
          provisionedAt = event.updatedAt;
        } else if (event?.status === "dead_lettered") {
          adProvisioningStatus = "failed";
        }

        const displayName = formatSignupDisplayName({
          firstName: submission.firstName,
          lastName: submission.lastName,
          preferredName: submission.preferredName,
        });

        let discordId: string | null = null;
        let discordUsername: string | null = null;
        if (submission.discordId) {
          const taken = await discordIdTaken(tx, submission.discordId, u.id);
          if (!taken) {
            discordId = submission.discordId;
            discordUsername = submission.discordUsername;
          }
        }

        await tx
          .update(user)
          .set({
            uin: submission.uin,
            netid: submission.netid,
            username: submission.username,
            firstName: submission.firstName,
            lastName: submission.lastName,
            preferredName: submission.preferredName,
            displayName,
            name: displayName,
            ...(discordId ? { discordId, discordUsername } : {}),
          })
          .where(eq(user.id, u.id));

        if (discordId) {
          await insertDiscordAccount(tx, u.id, discordId);
        }
      }
    }

    await tx
      .insert(memberProfiles)
      .values({
        userId: u.id,
        answers,
        answersSchemaVersionId,
        adProvisioningStatus,
        provisionedAt,
      })
      .onConflictDoNothing();
  });
}
