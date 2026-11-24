import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
  auditEvents,
  memberProfiles,
  user,
  usernameClaims,
} from "../db/schema";
import {
  formatSignupDisplayName,
  loadPublishedSignupForm,
} from "../forms/fields";
import {
  changedFields,
  compileFormSchema,
  flattenFieldErrors,
  profileSnapshot,
  splitAnswers,
} from "../forms/zod-compiler";
import { syncAdUser } from "../provisioning/ad-sync";
import {
  signupUsernameConflictErrors,
  signupUsernameConflictMessage,
} from "../signups/conflicts";
import type { PortalSession } from "../types";

export function identityValues(row: {
  firstName: string | null;
  lastName: string | null;
  preferredName: string | null;
  netid: string | null;
  username: string | null;
  uin: string | null;
  email: string;
  name: string;
}): Record<string, string> {
  let first = row.firstName ?? "";
  let last = row.lastName ?? "";
  if (!first && row.name) {
    const parts = row.name.trim().split(/\s+/);
    first = parts[0] ?? "";
    last = parts.slice(1).join(" ");
  }
  return {
    first_name: first,
    last_name: last,
    preferred_name: row.preferredName ?? "",
    netid: row.netid ?? "",
    username: row.username ?? row.netid ?? "",
    uin: row.uin ?? "",
    email: row.email,
  };
}

export async function saveProfile(
  data: Record<string, unknown>,
  session: PortalSession,
) {
  const form = await loadPublishedSignupForm();

  const parsed = compileFormSchema(form.fields).safeParse(data);
  if (!parsed.success) {
    return {
      ok: false as const,
      errors: flattenFieldErrors(parsed.error.flatten().fieldErrors),
    };
  }

  const { base, answers } = splitAnswers(parsed.data);
  const preferred = base.preferred_name?.trim() || null;
  const displayName = formatSignupDisplayName({
    firstName: base.first_name,
    lastName: base.last_name,
    preferredName: preferred,
  });

  const [current] = await db
    .select()
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  if (!current) {
    return { ok: false as const, errors: { email: "Account was not found." } };
  }

  const emailConflict = {
    ok: false as const,
    errors: {
      email:
        "Your email changed since you opened this form. Reload and try again.",
    },
  };
  const originalEmail = data._originalEmail;
  const submittedEmail =
    base.email === originalEmail ? current.email : base.email.toLowerCase();
  const emailChanged = submittedEmail !== current.email;
  if (
    emailChanged &&
    typeof originalEmail === "string" &&
    originalEmail !== current.email
  ) {
    return emailConflict;
  }

  const [profile] = await db
    .select({
      answers: memberProfiles.answers,
    })
    .from(memberProfiles)
    .where(eq(memberProfiles.userId, session.user.id))
    .limit(1);

  if (emailChanged) {
    const [emailTaken] = await db
      .select({ id: user.id })
      .from(user)
      .where(
        and(
          sql`lower(${user.email}) = ${submittedEmail}`,
          ne(user.id, current.id),
        ),
      )
      .limit(1);
    if (emailTaken) {
      return {
        ok: false as const,
        errors: { email: "This email is already in use." },
      };
    }
  }

  const [usernameTaken] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, base.username))
    .limit(1);
  if (usernameTaken && usernameTaken.id !== session.user.id) {
    return {
      ok: false as const,
      errors: { username: "This username is already in use." },
    };
  }

  if (base.username !== current.username) {
    const [claim] = await db
      .select()
      .from(usernameClaims)
      .where(eq(usernameClaims.username, base.username))
      .limit(1);
    if (
      claim &&
      (claim.signupSubmissionId ||
        (claim.userId && claim.userId !== session.user.id))
    ) {
      return {
        ok: false as const,
        errors: { username: signupUsernameConflictMessage },
      };
    }
  }

  const before = profileSnapshot({
    ...identityValues(current),
    ...((profile?.answers ?? {}) as Record<string, unknown>),
  });
  const after = profileSnapshot({
    first_name: base.first_name,
    last_name: base.last_name,
    preferred_name: preferred ?? "",
    netid: base.netid,
    username: base.username,
    uin: base.uin,
    email: submittedEmail,
    ...answers,
  });
  const changes = changedFields(before, after);

  try {
    const saved = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(user)
        .set({
          name: displayName,
          ...(emailChanged && {
            email: submittedEmail,
            emailVerified: false,
            entraSyncedEmail: sql`coalesce(${user.entraSyncedEmail}, ${user.email})`,
          }),
          netid: base.netid,
          username: base.username,
          uin: base.uin,
          firstName: base.first_name,
          lastName: base.last_name,
          preferredName: preferred,
          displayName,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(user.id, current.id),
            emailChanged ? eq(user.email, current.email) : undefined,
          ),
        )
        .returning({ id: user.id });
      if (!updated) return false;
      await tx
        .update(memberProfiles)
        .set({
          answers,
          answersSchemaVersionId: form.schemaVersionId,
        })
        .where(eq(memberProfiles.userId, session.user.id));
      if (changes.length) {
        await tx.insert(auditEvents).values({
          actorId: session.user.id,
          action: "profile.update",
          targetType: "user",
          targetId: session.user.id,
          before,
          after: { ...after, changes },
        });
      }
      return true;
    });
    if (!saved) return emailConflict;
  } catch (error) {
    // Return the field error only after the transaction has rolled back.
    const errors = signupUsernameConflictErrors(error);
    if (errors) return { ok: false as const, errors };
    throw error;
  }

  let adWarning: string | undefined;
  if (changes.length) {
    const previousSam = current.username || current.netid;
    if (previousSam) {
      const retryEmail =
        base.email === current.email &&
        current.entraSyncedEmail !== null &&
        current.entraSyncedEmail !== current.email;
      const ad = await syncAdUser({
        samAccountName: previousSam,
        username: base.username,
        firstName: base.first_name,
        lastName: base.last_name,
        preferredName: preferred ?? undefined,
        displayName,
        email: emailChanged || retryEmail ? submittedEmail : undefined,
        uin: base.uin,
      });
      if (!ad.ok) adWarning = ad.error;
    }
  }

  return { ok: true as const, adWarning };
}
