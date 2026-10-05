import { component$, Fragment, useSignal } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, desc, eq } from "drizzle-orm";
import { db } from "~/lib/db";
import {
  auditEvents,
  formSchemas,
  provisioningEvents,
  signupSubmissions,
} from "~/lib/db/schema";
import { getPermissions, requirePermission } from "~/lib/rbac/guards";
import {
  enqueueProvisioning,
  retryDeadLetter,
} from "~/lib/provisioning/outbox";
import { formatSignupDisplayName } from "~/lib/forms/fields";
import { submissionAnswers } from "~/lib/forms/submission-answers";
import type { FormSchemaDefinition } from "~/lib/types";

const PAGE_SIZE = 50;

/** Pending queue — UIN only for officers holding members.read.restricted. */
export const useSignupQueue = routeLoader$(async (event) => {
  await requirePermission(event, "signups.review");
  const perms = await getPermissions(event);
  const includeRestricted = perms.has("members.read.restricted");

  const rows = await db
    .select({
      id: signupSubmissions.id,
      firstName: signupSubmissions.firstName,
      lastName: signupSubmissions.lastName,
      preferredName: signupSubmissions.preferredName,
      netid: signupSubmissions.netid,
      username: signupSubmissions.username,
      email: signupSubmissions.email,
      discordId: signupSubmissions.discordId,
      discordUsername: signupSubmissions.discordUsername,
      discordInGuild: signupSubmissions.discordInGuild,
      answers: signupSubmissions.answers,
      schemaDefinition: formSchemas.fields,
      createdAt: signupSubmissions.createdAt,
      ...(includeRestricted ? { uin: signupSubmissions.uin } : {}),
    })
    .from(signupSubmissions)
    .leftJoin(
      formSchemas,
      eq(signupSubmissions.schemaVersionId, formSchemas.id),
    )
    .where(eq(signupSubmissions.status, "pending"))
    .orderBy(desc(signupSubmissions.createdAt))
    .limit(PAGE_SIZE);

  return rows.map(({ answers, schemaDefinition, ...r }) => ({
    ...r,
    displayName: formatSignupDisplayName(r),
    uin: "uin" in r ? r.uin : null,
    uinRestricted: !includeRestricted,
    answerDetails: submissionAnswers(
      answers as Record<string, unknown>,
      (schemaDefinition as FormSchemaDefinition | null)?.fields ?? [],
    ),
  }));
});

/** Dead-letter provisioning events (officer visibility + retry). */
export const useDeadLetters = routeLoader$(async (event) => {
  await requirePermission(event, "signups.review");
  return db
    .select({
      id: provisioningEvents.id,
      attempts: provisioningEvents.attempts,
      lastError: provisioningEvents.lastError,
      updatedAt: provisioningEvents.updatedAt,
    })
    .from(provisioningEvents)
    .where(eq(provisioningEvents.status, "dead_lettered"))
    .orderBy(desc(provisioningEvents.updatedAt))
    .limit(PAGE_SIZE);
});

export const useApproveSignup = routeAction$(async (data, event) => {
  const session = await requirePermission(event, "signups.approve");
  const id = String(data.id ?? "");
  const eventId = crypto.randomUUID();

  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(signupSubmissions)
      .set({
        status: "approved",
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
      })
      .where(
        and(
          eq(signupSubmissions.id, id),
          eq(signupSubmissions.status, "pending"),
        ),
      )
      .returning();
    if (!row) return null;

    await enqueueProvisioning(tx, row, eventId);
    await tx.insert(auditEvents).values({
      actorId: session.user.id,
      action: "signup.approve",
      targetType: "signup_submission",
      targetId: id,
      after: { netid: row.netid, eventId },
    });
    return row;
  });

  if (!claimed)
    return { ok: false as const, error: "Submission is not pending." };
  return { ok: true as const };
});

export const useDenySignup = routeAction$(async (data, event) => {
  const session = await requirePermission(event, "signups.approve");
  const id = String(data.id ?? "");
  const reason = String(data.reason ?? "").slice(0, 500);

  const claimed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(signupSubmissions)
      .set({
        status: "denied",
        reviewedBy: session.user.id,
        reviewedAt: new Date(),
        denialReason: reason || null,
      })
      .where(
        and(
          eq(signupSubmissions.id, id),
          eq(signupSubmissions.status, "pending"),
        ),
      )
      .returning({ id: signupSubmissions.id });
    if (!row) return null;

    await tx.insert(auditEvents).values({
      actorId: session.user.id,
      action: "signup.deny",
      targetType: "signup_submission",
      targetId: id,
      after: { reason },
    });
    return row;
  });

  if (!claimed)
    return { ok: false as const, error: "Submission is not pending." };
  return { ok: true as const };
});

export const useRetryProvisioning = routeAction$(async (data, event) => {
  await requirePermission(event, "provisioning.retry");
  await retryDeadLetter(String(data.id ?? ""));
  return { ok: true as const };
});

export default component$(() => {
  const queue = useSignupQueue();
  const deadLetters = useDeadLetters();
  const approve = useApproveSignup();
  const deny = useDenySignup();
  const retry = useRetryProvisioning();
  const expandedId = useSignal<string | null>(null);

  return (
    <main class="p-xl grid gap-xl max-w-7xl min-w-0">
      <header>
        <h1 class="font-display text-heading m-0">Signup queue</h1>
        <p class="text-text2 text-body m-0">
          {queue.value.length} pending review
        </p>
      </header>

      {queue.value.length === 0 ? (
        <p class="text-text3 text-body">
          No pending signups. New submissions appear here.
        </p>
      ) : (
        <div class="overflow-x-auto">
          <table class="w-full text-body-sm border-collapse">
            <thead>
              <tr class="text-left text-text3 text-caption">
                <th class="py-sm border-t border-border">Name</th>
                <th class="py-sm border-t border-border">NetID</th>
                <th class="py-sm border-t border-border">Username</th>
                <th class="py-sm border-t border-border">Discord</th>
                <th class="py-sm border-t border-border">UIN</th>
                <th class="py-sm border-t border-border">Submitted</th>
                <th class="py-sm border-t border-border">Actions</th>
              </tr>
            </thead>
            <tbody>
              {queue.value.map((s) => (
                <Fragment key={s.id}>
                  <tr>
                    <td class="py-sm border-t border-border text-text1">
                      {s.displayName}
                    </td>
                    <td class="py-sm border-t border-border font-mono text-text3">
                      {s.netid}
                    </td>
                    <td class="py-sm pr-md border-t border-border font-mono text-text3 break-all">
                      {s.username}
                    </td>
                    <td class="py-sm border-t border-border text-text3">
                      {s.discordUsername ? (
                        <>
                          <span class="font-mono">@{s.discordUsername}</span>
                          {s.discordInGuild === true
                            ? " · in server"
                            : s.discordInGuild === false
                              ? " · not in server"
                              : ""}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td class="py-sm border-t border-border font-mono text-text3">
                      {s.uin ?? "—"}
                    </td>
                    <td class="py-sm border-t border-border text-text3">
                      {new Date(s.createdAt).toLocaleDateString()}
                    </td>
                    <td class="py-sm border-t border-border">
                      <div class="flex gap-sm flex-wrap">
                        <button
                          type="button"
                          class="px-sm py-2xs rounded-control border border-border-visible text-text1 text-label cursor-pointer whitespace-nowrap"
                          aria-expanded={expandedId.value === s.id}
                          aria-controls={`signup-details-${s.id}`}
                          aria-label={`${expandedId.value === s.id ? "Hide details" : "View details"} for ${s.username}`}
                          onClick$={() => {
                            expandedId.value =
                              expandedId.value === s.id ? null : s.id;
                          }}
                        >
                          {expandedId.value === s.id
                            ? "Hide details"
                            : "View details"}
                        </button>
                        <button
                          type="button"
                          class="px-sm py-2xs rounded-control bg-accent text-white text-label cursor-pointer"
                          onClick$={async () => {
                            await approve.submit({ id: s.id });
                          }}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          class="px-sm py-2xs rounded-control border border-border-visible text-text1 text-label cursor-pointer"
                          onClick$={async () => {
                            const reason =
                              window.prompt("Reason for denial (optional)") ??
                              "";
                            await deny.submit({ id: s.id, reason });
                          }}
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                  <tr hidden={expandedId.value !== s.id}>
                    <td colSpan={7} class="pb-md">
                      <section
                        id={`signup-details-${s.id}`}
                        aria-labelledby={`signup-details-title-${s.id}`}
                        class="bg-surface1 border border-border rounded-component p-lg grid gap-md"
                      >
                        <header>
                          <h2
                            id={`signup-details-title-${s.id}`}
                            class="font-display text-subheading text-text1 m-0"
                          >
                            Submission details for {s.displayName}
                          </h2>
                          <p class="text-caption text-text3 m-0 mt-2xs">
                            Submitted {new Date(s.createdAt).toLocaleString()}
                          </p>
                        </header>
                        <dl class="m-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md">
                          {[
                            {
                              key: "first_name",
                              label: "First name",
                              value: s.firstName,
                            },
                            {
                              key: "last_name",
                              label: "Last name",
                              value: s.lastName,
                            },
                            {
                              key: "preferred_name",
                              label: "Preferred name",
                              value: s.preferredName || "Not provided",
                            },
                            { key: "netid", label: "NetID", value: s.netid },
                            {
                              key: "username",
                              label: "Username",
                              value: s.username,
                            },
                            {
                              key: "email",
                              label: "Personal email",
                              value: s.email,
                            },
                            {
                              key: "uin",
                              label: "UIN",
                              value: s.uinRestricted
                                ? "Restricted"
                                : (s.uin ?? "Not provided"),
                            },
                            {
                              key: "discord_username",
                              label: "Discord username",
                              value: s.discordUsername
                                ? `@${s.discordUsername}`
                                : "Not linked",
                            },
                            {
                              key: "discord_id",
                              label: "Discord ID",
                              value: s.discordId ?? "Not linked",
                            },
                            {
                              key: "discord_in_guild",
                              label: "In Discord server",
                              value:
                                s.discordInGuild === true
                                  ? "Yes"
                                  : s.discordInGuild === false
                                    ? "No"
                                    : "Unknown",
                            },
                          ].map((field) => (
                            <div
                              key={field.key}
                              class="min-w-0 grid gap-2xs content-start"
                            >
                              <dt class="text-caption text-text3">
                                {field.label}
                              </dt>
                              <dd class="m-0 text-body-sm text-text1 whitespace-pre-wrap break-words">
                                {field.value}
                              </dd>
                            </div>
                          ))}
                        </dl>
                        <h3 class="text-label text-text2 m-0 border-t border-border pt-md">
                          Form answers
                        </h3>
                        {s.answerDetails.length === 0 ? (
                          <p class="text-body-sm text-text3 m-0">
                            No additional answers submitted.
                          </p>
                        ) : (
                          <dl class="m-0 grid grid-cols-1 sm:grid-cols-2 gap-md">
                            {s.answerDetails.map((field) => (
                              <div
                                key={field.key}
                                class="min-w-0 grid gap-2xs content-start"
                              >
                                <dt class="text-caption text-text3">
                                  {field.label}
                                </dt>
                                <dd class="m-0 text-body-sm text-text1 whitespace-pre-wrap break-words">
                                  {field.value}
                                </dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </section>
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deadLetters.value.length > 0 && (
        <section class="grid gap-md">
          <h2 class="text-subheading m-0 text-warning">
            Provisioning failures
          </h2>
          {deadLetters.value.map((e) => (
            <div
              key={e.id}
              class="bg-surface1 border border-border rounded-component p-md flex items-center justify-between gap-md"
            >
              <div class="grid gap-2xs">
                <span class="font-mono text-caption text-text3">{e.id}</span>
                <span class="text-body-sm text-error">
                  {e.lastError ?? "unknown error"}
                </span>
                <span class="text-caption text-text4">
                  {e.attempts} attempts
                </span>
              </div>
              <button
                type="button"
                class="px-sm py-2xs rounded-control border border-border-visible text-text1 text-label cursor-pointer"
                onClick$={async () => {
                  await retry.submit({ id: e.id });
                }}
              >
                Retry now
              </button>
            </div>
          ))}
        </section>
      )}
    </main>
  );
});
