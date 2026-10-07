import {
  component$,
  Fragment,
  useSignal,
  useVisibleTask$,
} from "@builder.io/qwik";
import {
  routeAction$,
  routeLoader$,
  useNavigate,
  useLocation,
} from "@builder.io/qwik-city";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "~/lib/db";
import { auditEvents, signupSubmissions } from "~/lib/db/schema";
import { getPermissions, requirePermission } from "~/lib/rbac/guards";
import {
  enqueueProvisioning,
  retryProvisioning,
} from "~/lib/provisioning/outbox";
import { DynamicField } from "~/components/forms/dynamic-field";
import { signupEditFields, signupEditValues } from "~/lib/forms/signup-edit";
import { postedValues } from "~/lib/forms/zod-compiler";
import { saveSignupEdits, type SignupEditResult } from "~/lib/signups/edit";
import { formatSignupDisplayName } from "~/lib/forms/fields";
import { loadSignupQueue, provisioningErrorText } from "~/lib/signups/queue";
import { submissionAnswers } from "~/lib/forms/submission-answers";
import type { FormSchemaDefinition } from "~/lib/types";

const PAGE_SIZE = 50;

/** Review and provisioning queue. UIN requires members.read.restricted. */
export const useSignupQueue = routeLoader$(async (event) => {
  await requirePermission(event, "signups.review");
  const perms = await getPermissions(event);
  const includeRestricted = perms.has("members.read.restricted");

  const requestedPage = Number(event.url.searchParams.get("page") ?? 1);
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  const rows = await loadSignupQueue(
    includeRestricted,
    PAGE_SIZE + 1,
    (page - 1) * PAGE_SIZE,
  );

  return {
    page,
    hasNext: rows.length > PAGE_SIZE,
    rows: rows
      .slice(0, PAGE_SIZE)
      .map(({ answers, schemaDefinition, ...r }) => ({
        ...r,
        displayName: formatSignupDisplayName(r),
        uin: "uin" in r ? r.uin : null,
        uinRestricted: !includeRestricted,
        canEdit: r.status === "pending" && perms.has("signups.approve"),
        canRetry:
          perms.has("provisioning.retry") &&
          (r.provisioningStatus === "failed" ||
            r.provisioningStatus === "dead_lettered"),
        provisioningError: provisioningErrorText(r.provisioningError),
        editFields: signupEditFields(
          (schemaDefinition as FormSchemaDefinition | null) ?? { fields: [] },
          includeRestricted,
        ),
        editValues: postedValues(
          signupEditValues(
            r,
            answers as Record<string, unknown>,
            includeRestricted,
          ),
        ),
        answerDetails: submissionAnswers(
          answers as Record<string, unknown>,
          (schemaDefinition as FormSchemaDefinition | null)?.fields ?? [],
        ),
      })),
  };
});

export const useEditSignup = routeAction$(saveSignupEdits);

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
  const id = z.uuid().safeParse(data.id);
  if (!id.success || !(await retryProvisioning(id.data)))
    return {
      ok: false as const,
      error:
        "This account setup is no longer available to retry. Refresh its status.",
    };
  return { ok: true as const };
});

export default component$(() => {
  const queue = useSignupQueue();
  const approve = useApproveSignup();
  const deny = useDenySignup();
  const retry = useRetryProvisioning();
  const edit = useEditSignup();
  const editingId = useSignal<string | null>(null);
  const editResult = useSignal<SignupEditResult | null>(null);
  const savedId = useSignal<string | null>(null);
  const expandedId = useSignal<string | null>(null);
  const actionError = useSignal<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useVisibleTask$(({ track, cleanup }) => {
    const hasApproved = track(() =>
      queue.value.rows.some((s) => s.status === "approved"),
    );
    if (!hasApproved) return;
    let refreshing = false;
    const timer = setInterval(async () => {
      if (
        document.hidden ||
        refreshing ||
        location.isNavigating ||
        editingId.value ||
        approve.isRunning ||
        deny.isRunning ||
        retry.isRunning ||
        edit.isRunning
      )
        return;
      refreshing = true;
      try {
        await navigate(undefined, { replaceState: true, scroll: false });
      } catch {
        actionError.value =
          "Could not refresh account status. Try refreshing again.";
      } finally {
        refreshing = false;
      }
    }, 5_000);
    cleanup(() => clearInterval(timer));
  });

  return (
    <main class="p-xl grid gap-xl max-w-7xl min-w-0">
      <header>
        <h1 class="font-display text-heading m-0">Signup queue</h1>
        <p class="text-text2 text-body m-0">
          {queue.value.rows.filter((s) => s.status === "pending").length}{" "}
          awaiting review ·{" "}
          {queue.value.rows.filter((s) => s.status === "approved").length}{" "}
          awaiting account setup on this page
        </p>
        <button
          type="button"
          class="mt-sm text-accent text-label cursor-pointer"
          disabled={
            location.isNavigating ||
            editingId.value !== null ||
            edit.isRunning ||
            approve.isRunning ||
            deny.isRunning ||
            retry.isRunning
          }
          onClick$={async () => {
            if (location.isNavigating || editingId.value !== null) return;
            actionError.value = null;
            try {
              await navigate(undefined, { replaceState: true, scroll: false });
            } catch {
              actionError.value =
                "Could not refresh account status. Try again.";
            }
          }}
        >
          Refresh status
        </button>
      </header>

      {actionError.value && (
        <p role="alert" class="text-error text-body-sm m-0">
          {actionError.value}
        </p>
      )}

      {queue.value.rows.length === 0 ? (
        <p class="text-text3 text-body">
          No signups awaiting review or account setup on this page.
        </p>
      ) : (
        <div class="@container min-w-0 max-w-full overflow-x-auto">
          <table class="w-full text-body-sm border-collapse">
            <thead>
              <tr class="text-left text-text3 text-caption">
                <th class="py-sm border-t border-border">Name</th>
                <th class="py-sm border-t border-border">NetID</th>
                <th class="py-sm border-t border-border">Username</th>
                <th class="py-sm border-t border-border">Discord</th>
                <th class="py-sm border-t border-border">UIN</th>
                <th class="py-sm border-t border-border">Submitted</th>
                <th class="py-sm border-t border-border">Status</th>
                <th class="py-sm border-t border-border">Actions</th>
              </tr>
            </thead>
            <tbody>
              {queue.value.rows.map((s) => (
                <Fragment key={s.id}>
                  <tr>
                    <td class="py-sm border-t border-border text-text1">
                      {s.displayName}
                    </td>
                    <td class="py-sm border-t border-border font-mono text-text3">
                      {s.netid}
                      {s.duplicateNetid && (
                        <span class="block text-warning text-caption font-sans mt-2xs">
                          Duplicate NetID
                        </span>
                      )}
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
                    <td class="py-sm pr-md border-t border-border min-w-60 max-w-md">
                      <span
                        class={
                          s.provisioningStatus === "failed" ||
                          s.provisioningStatus === "dead_lettered" ||
                          (s.status === "approved" && !s.provisioningId)
                            ? "text-error"
                            : "text-text2"
                        }
                      >
                        {s.status === "pending"
                          ? "Awaiting review"
                          : s.provisioningStatus === "processing"
                            ? "Creating AD account"
                            : s.provisioningStatus === "failed"
                              ? "Account setup failed"
                              : s.provisioningStatus === "dead_lettered"
                                ? "Account setup stopped"
                                : !s.provisioningId
                                  ? "Account setup was not queued"
                                  : "Waiting to create AD account"}
                      </span>
                      {s.provisioningStatus === "failed" && s.nextAttemptAt && (
                        <p class="text-text3 text-caption m-0 mt-2xs">
                          Automatic retry at{" "}
                          {new Date(s.nextAttemptAt).toLocaleString()}.
                        </p>
                      )}
                      {s.provisioningStatus === "dead_lettered" && (
                        <p class="text-text3 text-caption m-0 mt-2xs">
                          Automatic retries have stopped.
                        </p>
                      )}
                    </td>
                    <td class="py-sm border-t border-border">
                      <div class="flex gap-sm flex-wrap">
                        <button
                          type="button"
                          class="px-sm py-2xs rounded-control border border-border-visible text-text1 text-label cursor-pointer whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                          disabled={editingId.value !== null || edit.isRunning}
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
                        {s.status === "pending" && (
                          <>
                            <button
                              type="button"
                              class="px-sm py-2xs rounded-control bg-accent text-white text-label cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              disabled={
                                !s.canEdit ||
                                location.isNavigating ||
                                editingId.value !== null ||
                                edit.isRunning ||
                                approve.isRunning ||
                                deny.isRunning
                              }
                              onClick$={async () => {
                                if (location.isNavigating) return;
                                actionError.value = null;
                                try {
                                  const result = await approve.submit({
                                    id: s.id,
                                  });
                                  if (!result.value.ok)
                                    actionError.value = result.value.error;
                                } catch {
                                  actionError.value =
                                    "Approval could not be saved. Try again.";
                                }
                              }}
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              class="px-sm py-2xs rounded-control border border-border-visible text-text1 text-label cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                              disabled={
                                !s.canEdit ||
                                location.isNavigating ||
                                editingId.value !== null ||
                                edit.isRunning ||
                                approve.isRunning ||
                                deny.isRunning
                              }
                              onClick$={async () => {
                                if (location.isNavigating) return;
                                const reason = window.prompt(
                                  "Reason for denial (optional)",
                                );
                                if (reason === null) return;
                                await deny.submit({ id: s.id, reason });
                              }}
                            >
                              Deny
                            </button>
                          </>
                        )}
                        {s.canRetry && s.provisioningId && (
                          <button
                            type="button"
                            class="px-sm py-2xs rounded-control border border-border-visible text-text1 text-label cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            disabled={
                              retry.isRunning ||
                              location.isNavigating ||
                              editingId.value !== null ||
                              edit.isRunning ||
                              approve.isRunning ||
                              deny.isRunning
                            }
                            onClick$={async () => {
                              if (location.isNavigating) return;
                              actionError.value = null;
                              try {
                                const result = await retry.submit({
                                  id: s.provisioningId!,
                                });
                                if (!result.value.ok)
                                  actionError.value = result.value.error;
                              } catch {
                                actionError.value =
                                  "Account setup could not be retried. Try again.";
                              }
                            }}
                          >
                            {retry.isRunning ? "Retrying..." : "Retry now"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                  {s.status === "approved" &&
                    (s.provisioningError || !s.provisioningId) && (
                      <tr>
                        <td colSpan={8} class="pb-md">
                          <section
                            aria-label={`Account setup error for ${s.displayName}, ${s.username}`}
                            class="w-[100cqw] max-w-full min-w-0 bg-surface1 border border-border rounded-component p-md grid gap-2xs [overflow-wrap:anywhere]"
                          >
                            <p class="text-label text-text1 m-0">
                              Account setup for {s.displayName}{" "}
                              <span class="font-mono text-text3">
                                ({s.username})
                              </span>
                            </p>
                            <p
                              role="alert"
                              class="text-error text-body-sm m-0 whitespace-pre-wrap"
                            >
                              {s.provisioningError ||
                                "Approval was saved, but account creation was not queued. Contact an administrator."}
                            </p>
                          </section>
                        </td>
                      </tr>
                    )}
                  <tr hidden={expandedId.value !== s.id}>
                    <td colSpan={8} class="pb-md">
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
                        {s.duplicateNetid && (
                          <p role="note" class="text-warning text-body-sm m-0">
                            Duplicate NetID: another pending signup, approved
                            signup, or member account uses this NetID. You can
                            still approve this signup with its unique username.
                          </p>
                        )}
                        {s.canEdit && editingId.value !== s.id && (
                          <div class="flex items-center gap-md">
                            <button
                              type="button"
                              disabled={
                                location.isNavigating ||
                                editingId.value !== null ||
                                approve.isRunning ||
                                deny.isRunning ||
                                edit.isRunning
                              }
                              class="px-md py-sm rounded-control border border-border-visible text-text1 text-label cursor-pointer disabled:opacity-50"
                              onClick$={() => {
                                if (
                                  location.isNavigating ||
                                  editingId.value !== null
                                )
                                  return;
                                editingId.value = s.id;
                                editResult.value = null;
                                savedId.value = null;
                              }}
                            >
                              Edit details
                            </button>
                            {savedId.value === s.id && (
                              <span
                                role="status"
                                class="text-success text-label"
                              >
                                Changes saved.
                              </span>
                            )}
                          </div>
                        )}
                        {editingId.value === s.id ? (
                          <form
                            preventdefault:submit
                            noValidate
                            class="grid gap-md"
                            onSubmit$={async (event) => {
                              if (edit.isRunning) return;
                              const data = new FormData(
                                event.target as HTMLFormElement,
                              );
                              data.set("id", s.id);
                              editResult.value = null;
                              try {
                                const result = await edit.submit(data);
                                editResult.value = result.value;
                                if (result.value.ok) {
                                  editingId.value = null;
                                  savedId.value = s.id;
                                }
                              } catch {
                                editResult.value = {
                                  ok: false,
                                  error:
                                    "Changes could not be saved. Try again.",
                                };
                              }
                            }}
                          >
                            <p class="text-body-sm text-text2 m-0">
                              Save your changes before approving or denying this
                              signup. Discord details come from the linked
                              account and cannot be edited here.
                            </p>
                            {s.uinRestricted && (
                              <p class="text-caption text-text3 m-0">
                                UIN is restricted and cannot be edited with your
                                permissions.
                              </p>
                            )}
                            <fieldset
                              disabled={edit.isRunning}
                              class="border-0 p-0 m-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-md items-start"
                            >
                              <legend class="sr-only">Signup details</legend>
                              {s.editFields.map((field) => (
                                <DynamicField
                                  key={field.key}
                                  idPrefix={`signup-edit-${s.id}-`}
                                  field={field}
                                  value={s.editValues[field.key] ?? ""}
                                  error={
                                    editResult.value?.ok === false
                                      ? editResult.value.errors?.[field.key]
                                      : undefined
                                  }
                                />
                              ))}
                            </fieldset>
                            {editResult.value?.ok === false &&
                              editResult.value.error && (
                                <p
                                  role="alert"
                                  class="text-error text-body-sm m-0"
                                >
                                  {editResult.value.error}
                                </p>
                              )}
                            <div class="flex gap-sm">
                              <button
                                type="submit"
                                disabled={edit.isRunning}
                                class="px-md py-sm rounded-control bg-accent text-white text-label cursor-pointer disabled:opacity-50"
                              >
                                {edit.isRunning ? "Saving..." : "Save changes"}
                              </button>
                              <button
                                type="button"
                                disabled={edit.isRunning}
                                class="px-md py-sm rounded-control border border-border-visible text-text1 text-label cursor-pointer disabled:opacity-50"
                                onClick$={() => {
                                  editingId.value = null;
                                  editResult.value = null;
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </form>
                        ) : (
                          <>
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
                                {
                                  key: "netid",
                                  label: "NetID",
                                  value: s.netid,
                                },
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
                          </>
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
      {(queue.value.page > 1 || queue.value.hasNext) && (
        <nav aria-label="Signup queue pages" class="flex items-center gap-md">
          <button
            type="button"
            class="text-accent text-label cursor-pointer disabled:opacity-50"
            disabled={
              queue.value.page === 1 ||
              location.isNavigating ||
              editingId.value !== null ||
              approve.isRunning ||
              deny.isRunning ||
              retry.isRunning ||
              edit.isRunning
            }
            onClick$={async () => {
              if (location.isNavigating || editingId.value !== null) return;
              try {
                await navigate(`?page=${queue.value.page - 1}`);
              } catch {
                actionError.value =
                  "Could not load the previous page. Try again.";
              }
            }}
          >
            Previous
          </button>
          <span class="text-text3 text-caption">Page {queue.value.page}</span>
          <button
            type="button"
            class="text-accent text-label cursor-pointer disabled:opacity-50"
            disabled={
              !queue.value.hasNext ||
              location.isNavigating ||
              editingId.value !== null ||
              approve.isRunning ||
              deny.isRunning ||
              retry.isRunning ||
              edit.isRunning
            }
            onClick$={async () => {
              if (location.isNavigating || editingId.value !== null) return;
              try {
                await navigate(`?page=${queue.value.page + 1}`);
              } catch {
                actionError.value = "Could not load the next page. Try again.";
              }
            }}
          >
            Next
          </button>
        </nav>
      )}
    </main>
  );
});
