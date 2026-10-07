import { component$ } from "@builder.io/qwik";
import {
  Link,
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

export const onRequest: RequestHandler = async (event) => {
  await requireProvisioningLogAccess(event);
  event.headers.set("Cache-Control", "private, no-store");
};
export const useProvisioningLogs = routeLoader$(loadProvisioningPage);

const Timestamp = component$<{ value: string }>(({ value }) => (
  <time dateTime={value} class="whitespace-nowrap">
    {formatProvisioningTime(value)}
  </time>
));

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
          Track AD account setup, credential delivery, and errors for each
          signup.
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
