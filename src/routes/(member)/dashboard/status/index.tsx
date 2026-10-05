import { component$ } from "@builder.io/qwik";
import {
  Form,
  routeAction$,
  routeLoader$,
  type RequestHandler,
} from "@builder.io/qwik-city";
import {
  checkWindowsApiHealth,
  lookupDirectoryUser,
} from "~/lib/provisioning/status";
import { requirePortalStatusAccess } from "~/lib/rbac/portal-status-access";

export const onRequest: RequestHandler = async (event) => {
  await requirePortalStatusAccess(event);
  event.headers.set("Cache-Control", "private, no-store");
};

export const useWindowsApiHealth = routeLoader$(async (event) => {
  await requirePortalStatusAccess(event);
  return checkWindowsApiHealth();
});

export const useDirectoryLookup = routeAction$(async (data, event) => {
  await requirePortalStatusAccess(event);
  return lookupDirectoryUser(String(data.username ?? ""));
});

export default component$(() => {
  const health = useWindowsApiHealth();
  const lookup = useDirectoryLookup();
  return (
    <main class="p-xl grid gap-lg max-w-3xl">
      <header>
        <h1 class="font-display text-heading m-0">Portal status</h1>
        <p class="text-text2 text-body">
          Check the connection from this portal server to the Windows API and
          look up an Active Directory account.
        </p>
      </header>
      <section
        class="p-lg rounded-control border border-border bg-surface1 grid gap-sm"
        aria-labelledby="health-heading"
      >
        <h2 id="health-heading" class="font-display text-subheading m-0">
          Windows API health
        </h2>
        <p class="text-body m-0" role="status">
          <strong>{health.value.ok ? "Healthy" : "Check failed"}</strong>.{" "}
          {health.value.message}
        </p>
        <p class="text-body-sm text-text3 m-0">
          GET /healthz
          {health.value.httpStatus !== null &&
            ` · HTTP ${health.value.httpStatus}`}
          <br />
          Checked at{" "}
          <time dateTime={health.value.checkedAt}>
            {health.value.checkedAt}
          </time>
        </p>
        <p class="text-body-sm text-text2 m-0">
          The health check runs when you open this page. A successful check
          confirms API connectivity. Use the lookup below to check Active
          Directory access.
        </p>
        <a href="/dashboard/status" class="text-accent text-label">
          Check again
        </a>
      </section>
      <section
        class="p-lg rounded-control border border-border bg-surface1 grid gap-sm"
        aria-labelledby="lookup-heading"
      >
        <h2 id="lookup-heading" class="font-display text-subheading m-0">
          Active Directory user lookup
        </h2>
        <p class="text-body-sm text-text2 m-0">
          Enter the ACM username, also called sAMAccountName.
        </p>
        <Form action={lookup} class="grid gap-sm">
          <label for="directory-username" class="text-label">
            ACM username
          </label>
          <input
            id="directory-username"
            name="username"
            type="text"
            required
            maxLength={64}
            autoComplete="off"
            class="h-[36px] px-sm rounded-control border border-border bg-surface2 text-body text-text1"
          />
          <button
            type="submit"
            disabled={lookup.isRunning}
            class="justify-self-start px-md py-sm rounded-control bg-accent text-white text-label cursor-pointer disabled:opacity-50"
          >
            {lookup.isRunning ? "Checking…" : "Check user"}
          </button>
        </Form>
        <div role="status" aria-live="polite">
          {lookup.isRunning ? (
            <p class="text-body-sm text-text2">Checking Active Directory…</p>
          ) : (
            lookup.value && (
              <>
                <p class="text-body m-0">
                  <strong>
                    {lookup.value.ok
                      ? lookup.value.exists
                        ? "User found"
                        : "User not found"
                      : "Lookup failed"}
                  </strong>
                  . {lookup.value.message}
                </p>
                <p class="text-body-sm text-text3">
                  Username: {lookup.value.username}
                  {lookup.value.httpStatus !== null &&
                    ` · HTTP ${lookup.value.httpStatus}`}
                </p>
              </>
            )
          )}
        </div>
      </section>
    </main>
  );
});
