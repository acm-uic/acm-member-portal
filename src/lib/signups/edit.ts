import type { RequestEventCommon } from "@builder.io/qwik-city";
import { and, eq, ne, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  auditEvents,
  formSchemas,
  signupSubmissions,
  user,
} from "../db/schema";
import { signupEditFields, signupEditValues } from "../forms/signup-edit";
import {
  changedFields,
  compileFormSchema,
  flattenFieldErrors,
  splitAnswers,
} from "../forms/zod-compiler";
import { getPermissions, requirePermission } from "../rbac/guards";
import type { FormSchemaDefinition } from "../types";

export type SignupEditResult =
  { ok: true } | { ok: false; error?: string; errors?: Record<string, string> };

export async function saveSignupEdits(
  data: Record<string, unknown>,
  event: RequestEventCommon,
): Promise<SignupEditResult> {
  const session = await requirePermission(event, "signups.approve");
  const permissions = await getPermissions(event);
  const includeRestricted = permissions.has("members.read.restricted");
  const id = z.uuid().safeParse(data.id);
  if (!id.success) return { ok: false, error: "Submission was not found." };

  return db.transaction(async (tx) => {
    // Approval/denial must wait for this edit to commit before reading the row.
    const [current] = await tx
      .select()
      .from(signupSubmissions)
      .where(
        and(
          eq(signupSubmissions.id, id.data),
          eq(signupSubmissions.status, "pending"),
        ),
      )
      .for("update");
    if (!current) return { ok: false, error: "Submission is not pending." };

    const [schema] = await tx
      .select({ fields: formSchemas.fields })
      .from(formSchemas)
      .where(eq(formSchemas.id, current.schemaVersionId));
    if (!schema)
      return { ok: false, error: "The submission's form was not found." };
    const fields = signupEditFields(
      schema.fields as FormSchemaDefinition,
      includeRestricted,
    );
    const input = { ...data };
    for (const field of fields) {
      if (field.type === "checkbox") {
        input[field.key] =
          input[field.key] === true ||
          input[field.key] === "true" ||
          input[field.key] === "on";
      }
      if (
        !field.required &&
        (field.type === "select" || field.type === "number") &&
        input[field.key] === ""
      ) {
        input[field.key] = undefined;
      }
    }
    const parsed = compileFormSchema(fields).safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        errors: flattenFieldErrors(parsed.error.flatten().fieldErrors),
      };
    }
    const { base, answers } = splitAnswers(parsed.data);
    const errors: Record<string, string> = {};
    const pending = await tx
      .select({
        netid: signupSubmissions.netid,
        username: signupSubmissions.username,
      })
      .from(signupSubmissions)
      .where(
        and(
          ne(signupSubmissions.id, current.id),
          eq(signupSubmissions.status, "pending"),
          or(
            eq(signupSubmissions.netid, base.netid),
            eq(signupSubmissions.username, base.username),
          ),
        ),
      );
    if (pending.some((row) => row.netid === base.netid))
      errors.netid = "A signup with this NetID is already pending review.";
    if (pending.some((row) => row.username === base.username))
      errors.username =
        "A signup with this username is already pending review.";
    const accounts = await tx
      .select({ netid: user.netid, username: user.username })
      .from(user)
      .where(or(eq(user.netid, base.netid), eq(user.username, base.username)));
    if (accounts.some((row) => row.netid === base.netid))
      errors.netid = "This NetID is already in use.";
    if (accounts.some((row) => row.username === base.username))
      errors.username = "This username is already in use.";
    if (Object.keys(errors).length) return { ok: false, errors };

    const oldAnswers = current.answers as Record<string, unknown>;
    const updated = {
      firstName: base.first_name,
      lastName: base.last_name,
      preferredName: base.preferred_name?.trim() || null,
      netid: base.netid,
      username: base.username,
      email: base.email,
      ...(includeRestricted ? { uin: base.uin } : {}),
      answers: { ...oldAnswers, ...answers },
    };
    const before = signupEditValues(current, oldAnswers, includeRestricted);
    const after = signupEditValues(updated, updated.answers, includeRestricted);
    const changes = changedFields(before, after);
    if (changes.length) {
      await tx
        .update(signupSubmissions)
        .set(updated)
        .where(eq(signupSubmissions.id, current.id));
      await tx.insert(auditEvents).values({
        actorId: session.user.id,
        action: "signup.update",
        targetType: "signup_submission",
        targetId: current.id,
        before,
        after: { ...after, changes },
      });
    }
    return { ok: true };
  });
}
