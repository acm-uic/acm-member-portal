import { $, component$, useSignal } from "@builder.io/qwik";
import type { DocumentHead, RequestHandler } from "@builder.io/qwik-city";
import { ThemeToggle } from "~/components/theme-toggle";
import {
  activationUnconfirmed,
  parseActivationResponse,
  type ActivationResult,
} from "~/lib/activation-response";

export const onGet: RequestHandler = ({ headers }) => {
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");
};

export default component$(() => {
  const pending = useSignal(false);
  const result = useSignal<ActivationResult>();
  const submit = $(async (event: Event) => {
    if (
      pending.value ||
      result.value?.ok ||
      (result.value && !result.value.ok && result.value.uncertain)
    )
      return;
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    // Passwords stay in DOM/local handler variables, never Qwik signals or actions.
    const username = String(data.get("username") ?? "");
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      result.value = { ok: false, error: "The new passwords do not match." };
      return;
    }
    if (newPassword === currentPassword) {
      result.value = {
        ok: false,
        error: "Choose a password different from the temporary password.",
      };
      return;
    }
    pending.value = true;
    result.value = undefined;
    try {
      const response = await fetch("/api/activate/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username,
          currentPassword,
          newPassword,
          confirmPassword,
        }),
      });
      result.value = parseActivationResponse(
        await response.json(),
        response.ok,
      );
    } catch {
      result.value = {
        ok: false,
        error: activationUnconfirmed,
        uncertain: true,
      };
    } finally {
      form.reset();
      pending.value = false;
    }
  });
  const finished =
    result.value?.ok ||
    (result.value && !result.value.ok && result.value.uncertain);
  return (
    <main class="min-h-screen grid place-items-center p-xl">
      <div class="absolute top-md right-md">
        <ThemeToggle />
      </div>
      <section class="max-w-md w-full min-w-0 bg-surface1 border border-border rounded-component shadow-card p-xl grid gap-md">
        <h1 class="font-display text-heading m-0">Activate your ACM account</h1>
        <p id="activation-help" class="text-body text-text2 m-0">
          After your signup is approved and you receive temporary credentials,
          choose your own ACM password here before signing in with Microsoft.
          Enter your ACM username, without @acmuic.org. Active Directory checks
          its password policies.
        </p>
        {!finished && (
          <form
            method="post"
            action="/api/activate/"
            preventdefault:submit
            onSubmit$={submit}
            aria-describedby="activation-help"
            class="grid gap-md"
          >
            <fieldset
              disabled={pending.value}
              class="grid gap-md border-0 p-0 m-0"
            >
              <legend class="sr-only">Activate account</legend>
              <label class="grid gap-xs">
                <span class="text-label text-text2">ACM username</span>
                <input
                  name="username"
                  type="text"
                  required
                  maxLength={20}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellcheck={false}
                  class="w-full min-w-0 px-md py-sm rounded-control bg-surface2 border border-border"
                />
              </label>
              {[
                {
                  name: "currentPassword",
                  label: "Temporary password",
                  autocomplete: "current-password",
                },
                {
                  name: "newPassword",
                  label: "New password",
                  autocomplete: "new-password",
                },
                {
                  name: "confirmPassword",
                  label: "Confirm new password",
                  autocomplete: "new-password",
                },
              ].map((field) => (
                <label key={field.name} class="grid gap-xs">
                  <span class="text-label text-text2">{field.label}</span>
                  <input
                    name={field.name}
                    type="password"
                    required
                    maxLength={256}
                    autoComplete={field.autocomplete}
                    class="w-full min-w-0 px-md py-sm rounded-control bg-surface2 border border-border"
                  />
                </label>
              ))}
              <button
                type="submit"
                class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer disabled:opacity-50"
              >
                {pending.value ? "Changing password…" : "Activate account"}
              </button>
            </fieldset>
          </form>
        )}
        <div aria-live="polite" role="status">
          {result.value && (
            <p
              class={`text-body m-0 ${result.value.ok ? "text-success" : "text-danger"}`}
            >
              {result.value.ok
                ? "Your ACM password was changed. Allow up to 30 minutes for directory synchronization, then sign in with Microsoft using your new password. Synchronization has not been verified by this page."
                : result.value.error}
            </p>
          )}
        </div>
        <a href="/login/" class="text-accent text-label">
          Continue to Microsoft sign-in
        </a>
      </section>
    </main>
  );
});

export const head: DocumentHead = { title: "Activate account | ACM@UIC" };
