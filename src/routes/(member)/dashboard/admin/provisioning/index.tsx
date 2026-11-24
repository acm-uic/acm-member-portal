import { component$ } from "@builder.io/qwik";
import {
  Form,
  Link,
  routeAction$,
  routeLoader$,
  useLocation,
  type RequestHandler,
} from "@builder.io/qwik-city";
import {
  loadProvisioningPage,
  requireProvisioningLogAccess,
} from "~/lib/provisioning/log-page";
import {
  formatProvisioningTime,
  provisioningPageHref,
  PROVISIONING_STATUSES,
  STATUS_LABELS,
} from "~/lib/provisioning/log-view";
import {
  lookupEntraSync,
  type EntraSyncDetails,
} from "~/lib/provisioning/status";

export const onRequest: RequestHandler = async (event) => {
  await requireProvisioningLogAccess(event);
  event.headers.set("Cache-Control", "private, no-store");
};
export const useProvisioningLogs = routeLoader$(loadProvisioningPage);
export const useEntraSync = routeAction$(async (data, event) => {
  await requireProvisioningLogAccess(event);
  return lookupEntraSync(String(data.username ?? ""));
});

const Timestamp = component$<{ value: string }>(({ value }) => (
  <time dateTime={value} class="whitespace-nowrap">
    {formatProvisioningTime(value)}
  </time>
));

type Inspection = NonNullable<EntraSyncDetails["inspection"]>;
type Retry = NonNullable<NonNullable<EntraSyncDetails["retries"]>["userHash"]>;
const CONNECT_STATES: Record<Inspection["state"], string> = {
  "ad-not-imported":
    "The AD connector has no record for this account. Check OU scope and the last AD import.",
  "source-sync-error":
    "The AD connector reports a synchronization error. Open this account in Synchronization Service Manager for details.",
  "metaverse-link-missing":
    "The AD connector has the account, but it has no metaverse link. Check inbound rule scope and sync errors.",
  "target-link-missing":
    "The metaverse has the account, but it has no Entra connector link. Check outbound rule scope and cloudFiltered.",
  "target-unavailable":
    "The Entra connector record could not be identified. Check the connectors and run history in Synchronization Service Manager.",
  "target-sync-error":
    "The Entra connector reports a synchronization error. Open that connector object for details.",
  "export-error": "Entra Connect reports an export error for this account.",
  "target-linked":
    "The account has an Entra connector link. Connect reports no current export error for it. Verify the account and its UPN in Entra.",
};

const FAILURE_GUIDANCE: Record<NonNullable<Retry["failureCode"]>, string> = {
  "settings-unavailable":
    "Check that the provisioning service can read a valid EntraSync settings.json file.",
  "module-unavailable":
    "Check that the ADSync PowerShell module loads under the provisioning service identity on the Connect server.",
  "scheduler-unavailable":
    "Check whether the provisioning service identity can read the Connect scheduler.",
  "scheduler-suspended":
    "Check whether Connect is in staging mode or its scheduler is suspended.",
  "directory-disabled":
    "The Connect scheduler has directory synchronization disabled.",
  "directory-busy":
    "A directory sync was already running when the worker tried to start one.",
  "outside-managed-ou":
    "Compare the account's AD distinguished name with UsersOu in the Connect settings file.",
  "adsync-command-failed":
    "The ADSync command failed. Check connector settings, service identity permissions, and the per-account connector status.",
  "connect-read-failed":
    "Connect could not read this account's sync records. Check the configured AD connector and the provisioning service identity's read access.",
  "request-failed":
    "The request failed. Check the AcmProvisioning Application log and the Connect service.",
  timeout:
    "PowerShell did not respond within the time limit. Check the Connect server and ADSync service.",
};

const SyncRetry = component$<{ label: string; job: Retry | null }>(
  ({ label, job }) => (
    <div>
      <dt class="text-label">{label}</dt>
      <dd class="m-0">
        {job ? (
          <>
            {job.attempts
              ? `Retry pending · ${job.attempts}${job.attempts === 1000 ? "+" : ""} failed attempts`
              : "Queued"}
            {" · Next attempt "}
            <Timestamp value={job.nextAttempt} />
            {job.failureCode && (
              <p class="m-0">{FAILURE_GUIDANCE[job.failureCode]}</p>
            )}
            <p class="m-0 text-caption text-text3 break-all">Job ID {job.id}</p>
          </>
        ) : (
          "No request pending"
        )}
      </dd>
    </div>
  ),
);

const EntraDiagnostics = component$<{ username?: string }>(({ username }) => {
  const lookup = useEntraSync();
  const details = lookup.value?.details;
  const inspection = details?.inspection;
  const duplicate =
    inspection?.conflictAttribute ||
    /^(?:duplicate-attribute|(?:Quarantined)?AttributeValueMustBeUnique|InvalidSoftMatch|ObjectTypeMismatch)$/i.test(
      inspection?.errorCode ?? "",
    );
  return (
    <section
      class="p-lg rounded-control border border-border bg-surface1 grid gap-sm"
      aria-labelledby="entra-heading"
    >
      <h2 id="entra-heading" class="font-display text-subheading m-0">
        Entra sync diagnostics
      </h2>
      <Form action={lookup} class="flex flex-wrap items-end gap-sm">
        <label class="grid gap-2xs text-label">
          ACM username
          <input
            name="username"
            value={username}
            required
            maxLength={64}
            autoComplete="off"
            class="h-[36px] px-sm rounded-control border border-border bg-surface2 text-body-sm text-text1"
          />
        </label>
        <button
          type="submit"
          disabled={lookup.isRunning}
          class="h-[36px] px-md rounded-control bg-accent text-white text-label cursor-pointer disabled:opacity-50"
        >
          {lookup.isRunning ? "Checking…" : "Check sync"}
        </button>
      </Form>
      <div role="status" aria-live="polite" class="grid gap-sm text-body-sm">
        {lookup.isRunning
          ? "Checking the Windows provisioning service and Entra Connect…"
          : lookup.value && (
              <>
                {lookup.value.message && (
                  <p class="m-0">{lookup.value.message}</p>
                )}
                {details?.account && (
                  <>
                    <p class="m-0 break-all">
                      <strong>
                        {details.account.userPrincipalName ??
                          details.samAccountName}
                      </strong>
                      <br />
                      {details.account.distinguishedName}
                    </p>
                    <div class="grid gap-2xs">
                      <p class="text-label m-0">Directory object sync</p>
                      <p class="m-0">
                        {inspection
                          ? CONNECT_STATES[inspection.state]
                          : details.inspectionFailure
                            ? FAILURE_GUIDANCE[details.inspectionFailure]
                            : "Connect could not return a status for this account."}
                      </p>
                      {inspection?.targetDn && (
                        <p class="m-0 break-all">
                          Entra connector DN <code>{inspection.targetDn}</code>
                        </p>
                      )}
                      {inspection?.errorCode && (
                        <p class="m-0">
                          Error code <code>{inspection.errorCode}</code>
                        </p>
                      )}
                      {inspection?.technicalMessage ? (
                        <div class="grid gap-2xs">
                          <p class="text-label m-0">Entra Connect message</p>
                          <pre class="m-0 text-error font-mono whitespace-pre-wrap break-words">
                            {inspection.technicalMessage}
                          </pre>
                        </div>
                      ) : inspection?.state === "export-error" ? (
                        <p class="m-0">
                          Open this connector object’s Export Error tab in
                          Synchronization Service Manager for the vendor
                          message.
                        </p>
                      ) : null}
                      {inspection?.conflictAttribute && (
                        <p class="m-0">
                          Conflicting attribute{" "}
                          <code>{inspection.conflictAttribute}</code>
                          {inspection.conflictValue && (
                            <>
                              {" · "}
                              <code>{inspection.conflictValue}</code>
                            </>
                          )}
                        </p>
                      )}
                      {inspection?.conflictObjectId && (
                        <p class="m-0 break-all">
                          Conflicting Entra object ID{" "}
                          <code>{inspection.conflictObjectId}</code>
                        </p>
                      )}
                      {duplicate && (
                        <p class="m-0">
                          Look up the conflicting object in Entra and verify
                          which account should own the value before correcting
                          it in the source directory. For an SMTP conflict,
                          check both AD <code>mail</code> and{" "}
                          <code>proxyAddresses</code>. Entra can use{" "}
                          <code>mail</code> as the SMTP address when{" "}
                          <code>proxyAddresses</code> is empty.{" "}
                          <a
                            class="text-accent"
                            href="https://learn.microsoft.com/en-us/entra/identity/hybrid/connect/how-to-connect-health-diagnose-sync-errors"
                          >
                            Microsoft duplicate attribute guidance
                          </a>
                        </p>
                      )}
                    </div>
                    <div>
                      <p class="text-label m-0">
                        Last password hash sync result
                      </p>
                      <p class="m-0">
                        {inspection?.passwordStatus === "unavailable" ? (
                          "Connect's password sync history could not be read."
                        ) : inspection?.passwordStatus ? (
                          <>
                            <code>{inspection.passwordStatus}</code>
                            {inspection.passwordCheckedAt && (
                              <>
                                {" "}
                                ·{" "}
                                <Timestamp
                                  value={inspection.passwordCheckedAt}
                                />
                              </>
                            )}
                          </>
                        ) : (
                          "No recent password sync result was returned."
                        )}
                      </p>
                    </div>
                    {details.retries?.enabled ? (
                      <dl class="m-0 grid gap-sm">
                        <SyncRetry
                          label="Password hash request for this account"
                          job={details.retries.userHash}
                        />
                        <SyncRetry
                          label="Directory sync request (shared across all accounts)"
                          job={details.retries.directory}
                        />
                      </dl>
                    ) : (
                      <p class="m-0">
                        The provisioning service's sync request worker is
                        disabled.
                      </p>
                    )}
                  </>
                )}
                <p class="m-0 text-caption text-text3">
                  Checked <Timestamp value={lookup.value.checkedAt} />
                </p>
              </>
            )}
      </div>
    </section>
  );
});

export default component$(() => {
  const data = useProvisioningLogs();
  const location = useLocation();
  const selected = data.value.selected;
  const filters = {
    q: data.value.q,
    status: data.value.status,
    page: data.value.page,
  };
  return (
    <main class="p-xl grid gap-lg max-w-7xl min-w-0">
      <header>
        <h1 class="font-display text-heading m-0">Provisioning logs</h1>
        <p class="text-body text-text2">
          Track AD account setup, credential delivery, activation, and errors
          for each signup.
        </p>
        <p class="text-caption text-text3">
          All times are Central time (America/Chicago). Updated{" "}
          <Timestamp value={data.value.checkedAt} />.
        </p>
        <a
          href={location.url.pathname + location.url.search}
          class="text-accent text-label"
        >
          Refresh logs
        </a>
      </header>
      {data.value.selectedRequested ? (
        <>
          <Link
            href={provisioningPageHref(filters)}
            class="text-accent text-label"
          >
            Back to provisioning requests
          </Link>
          {!selected ? (
            <p role="status" class="text-body text-text2">
              Provisioning request not found.
            </p>
          ) : (
            <>
              <section
                class="p-lg rounded-control border border-border bg-surface1 grid gap-sm"
                aria-labelledby="request-heading"
              >
                <h2
                  id="request-heading"
                  class="font-display text-subheading m-0"
                >
                  {selected.displayName}
                </h2>
                <p class="text-body-sm m-0">
                  <span class="font-mono">{selected.username}</span> · NetID{" "}
                  {selected.netid}
                </p>
                <p class="text-body m-0">
                  {STATUS_LABELS[selected.status]} · Signup{" "}
                  {selected.signupStatus}
                </p>
                <p class="text-body-sm text-text2 m-0">
                  Credential delivery:{" "}
                  {selected.deliveryMode === "email" ? "Email" : "Manual"} ·{" "}
                  {selected.deliveryStatus ?? "Delivery not recorded"}
                </p>
                <p class="text-body-sm text-text2 m-0">
                  Initial password change:{" "}
                  {selected.activatedAt ? (
                    <>
                      Recorded <Timestamp value={selected.activatedAt} />
                    </>
                  ) : (
                    "Not recorded by the portal"
                  )}
                </p>
                {!selected.activatedAt && (
                  <p class="text-caption text-text3 m-0">
                    A password may have been changed directly in AD or before
                    portal activation tracking was available.
                  </p>
                )}
                <p class="text-body-sm text-text2 m-0">
                  Recorded attempt counter: {selected.attempts}. The counter
                  resets when an administrator retries; history is retained.
                </p>
                <p class="text-caption text-text3 m-0">
                  Queued <Timestamp value={selected.createdAt} /> · Last updated{" "}
                  <Timestamp value={selected.updatedAt} />
                </p>
                {selected.nextAttemptAt && (
                  <p class="text-body-sm text-text2 m-0">
                    Next automatic retry:{" "}
                    <Timestamp value={selected.nextAttemptAt} />
                  </p>
                )}
                {selected.lastError && (
                  <div role="status" class="grid gap-2xs">
                    <p class="text-label m-0">Latest error</p>
                    <pre class="m-0 text-error text-body-sm font-mono whitespace-pre-wrap break-words">
                      {selected.lastError}
                    </pre>
                  </div>
                )}
                <p class="text-caption text-text3 m-0 break-all">
                  Request ID: {selected.id}
                </p>
              </section>
              <EntraDiagnostics username={selected.username} />
              <section class="grid gap-sm" aria-labelledby="history-heading">
                <h2
                  id="history-heading"
                  class="font-display text-subheading m-0"
                >
                  Request history
                </h2>
                <p class="text-body-sm text-text2 m-0">
                  Newest entries first. Attempts made before history recording
                  was enabled are unavailable; the current status and latest
                  saved error appear above.
                </p>
                {data.value.logs.length === 0 ? (
                  <p role="status" class="text-body text-text3">
                    No history entries on this page.
                  </p>
                ) : (
                  <ol class="list-none m-0 p-0 grid gap-sm">
                    {data.value.logs.map((entry) => (
                      <li
                        key={entry.id}
                        class="p-md rounded-control border border-border bg-surface1 grid gap-2xs"
                      >
                        <p class="text-caption text-text3 m-0">
                          <Timestamp value={entry.createdAt} />
                          {entry.attempt > 0 && ` · Attempt ${entry.attempt}`}
                        </p>
                        <p class="text-body-sm m-0">{entry.message}</p>
                        {entry.error && (
                          <pre class="m-0 text-error text-body-sm font-mono whitespace-pre-wrap break-words">
                            {entry.error}
                          </pre>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
                <nav
                  aria-label="Request history pages"
                  class="flex gap-md items-center text-body-sm"
                >
                  {data.value.logPage > 1 && (
                    <Link
                      class="text-accent"
                      href={provisioningPageHref({
                        ...filters,
                        event: selected.id,
                        logPage: data.value.logPage - 1,
                      })}
                    >
                      Newer entries
                    </Link>
                  )}
                  <span class="text-text3">Page {data.value.logPage}</span>
                  {data.value.hasOlderLogs && (
                    <Link
                      class="text-accent"
                      href={provisioningPageHref({
                        ...filters,
                        event: selected.id,
                        logPage: data.value.logPage + 1,
                      })}
                    >
                      Older entries
                    </Link>
                  )}
                </nav>
              </section>
            </>
          )}
        </>
      ) : (
        <>
          <EntraDiagnostics />
          <form method="get" class="flex flex-wrap gap-md items-end">
            <label class="grid gap-2xs text-label">
              Applicant or username
              <input
                name="q"
                type="search"
                value={data.value.q}
                maxLength={100}
                placeholder="Search name, NetID, or username"
                class="h-[36px] px-sm rounded-control border border-border bg-surface2 text-body-sm text-text1 w-72 max-w-full"
              />
            </label>
            <label class="grid gap-2xs text-label">
              Status
              <select
                name="status"
                value={data.value.status}
                class="h-[36px] px-sm rounded-control border border-border bg-surface2 text-body-sm text-text1"
              >
                <option value="">All statuses</option>
                {PROVISIONING_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              class="h-[36px] px-md rounded-control bg-accent text-white text-label cursor-pointer"
            >
              Apply filters
            </button>
            {(data.value.q || data.value.status) && (
              <Link
                class="text-accent text-label py-sm"
                href={provisioningPageHref({})}
              >
                Clear filters
              </Link>
            )}
          </form>
          {data.value.rows.length === 0 ? (
            <p role="status" class="text-body text-text3">
              No provisioning requests on this page match these filters.
            </p>
          ) : (
            <div class="overflow-x-auto min-w-0">
              <table class="w-full text-body-sm border-collapse">
                <caption class="text-left text-caption text-text3 pb-sm">
                  Requests ordered by last update, including completed account
                  setup.
                </caption>
                <thead>
                  <tr class="text-left text-caption text-text3">
                    {[
                      "Applicant",
                      "Status",
                      "Timing",
                      "Latest error",
                      "History",
                    ].map((heading) => (
                      <th
                        key={heading}
                        scope="col"
                        class="py-sm pr-md border-t border-border"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.value.rows.map((row) => (
                    <tr key={row.id}>
                      <td class="py-md pr-md align-top border-t border-border text-text1">
                        {row.displayName}
                        <span class="block font-mono text-text2">
                          {row.username}
                        </span>
                        <span class="block text-caption text-text3">
                          NetID {row.netid}
                        </span>
                      </td>
                      <td
                        class={`py-md pr-md align-top border-t border-border ${row.status === "failed" || row.status === "dead_lettered" ? "text-error" : "text-text2"}`}
                      >
                        {STATUS_LABELS[row.status]}
                        <span class="block text-caption text-text3">
                          {row.deliveryMode === "email" ? "Email" : "Manual"} ·{" "}
                          {row.deliveryStatus ?? "Delivery not recorded"}
                        </span>
                        <span class="block text-caption text-text3">
                          {row.activatedAt
                            ? "Initial password change recorded"
                            : "Initial password change not recorded"}
                        </span>
                      </td>
                      <td class="py-md pr-md align-top border-t border-border text-text3">
                        <span class="block text-caption">Last updated</span>
                        <Timestamp value={row.updatedAt} />
                        <span class="block text-caption mt-sm">
                          Next automatic retry
                        </span>
                        {row.nextAttemptAt ? (
                          <Timestamp value={row.nextAttemptAt} />
                        ) : (
                          "None scheduled"
                        )}
                      </td>
                      <td class="py-md pr-md align-top border-t border-border min-w-60 max-w-md">
                        <pre
                          class={`m-0 text-body-sm font-mono whitespace-pre-wrap break-words ${row.lastError ? "text-error" : "text-text3"}`}
                        >
                          {row.lastError ?? "No error recorded"}
                        </pre>
                      </td>
                      <td class="py-md align-top border-t border-border">
                        <Link
                          class="text-accent whitespace-nowrap"
                          aria-label={`View provisioning history for ${row.displayName}`}
                          href={provisioningPageHref({
                            ...filters,
                            event: row.id,
                          })}
                        >
                          View log
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <nav
            aria-label="Provisioning request pages"
            class="flex gap-md items-center text-body-sm"
          >
            {data.value.page > 1 && (
              <Link
                class="text-accent"
                href={provisioningPageHref({
                  ...filters,
                  page: data.value.page - 1,
                })}
              >
                Previous page
              </Link>
            )}
            <span class="text-text3">Page {data.value.page}</span>
            {data.value.hasNext && (
              <Link
                class="text-accent"
                href={provisioningPageHref({
                  ...filters,
                  page: data.value.page + 1,
                })}
              >
                Next page
              </Link>
            )}
          </nav>
        </>
      )}
    </main>
  );
});
