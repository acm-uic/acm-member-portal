import { $, component$, useSignal } from "@builder.io/qwik";
import type { PasswordChangeResult } from "~/lib/provisioning/change-password";
import {
  parsePasswordChangeResponse,
  unconfirmedPasswordChangeError,
} from "~/lib/password-change-response";

export const PasswordChange = component$(() => {
  const pending = useSignal(false);
  const result = useSignal<PasswordChangeResult>();
  const submit = $(async (event: Event) => {
    if (pending.value) return;
    const form = event.target as HTMLFormElement;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirmPassword = String(data.get("confirmPassword") ?? "");
    result.value = undefined;
    if (newPassword !== confirmPassword) {
      result.value = { ok: false, error: "The new passwords do not match." };
      return;
    }
    if (currentPassword === newPassword) {
      result.value = {
        ok: false,
        error: "Choose a new password that differs from your current password.",
      };
      return;
    }
    pending.value = true;
    try {
      const response = await fetch("/api/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      result.value = parsePasswordChangeResponse(
        await response.json(),
        response.ok,
      );
    } catch {
      result.value = {
        ok: false,
        error: unconfirmedPasswordChangeError,
      };
    } finally {
      form.reset();
      pending.value = false;
    }
  });
  return (
    <section class="grid gap-md border-t border-border pt-lg">
      <div>
        <h2 class="text-subheading m-0">Change ACM password</h2>
        <p class="text-text2 text-body m-0" id="password-help">
          Change the password for your ACM Active Directory account. Enter your
          current ACM password, including a temporary password if this is your
          first change. Active Directory checks its password policies when you
          submit.
        </p>
      </div>
      <form
        preventdefault:submit
        onSubmit$={submit}
        class="grid gap-md"
        aria-describedby="password-help"
      >
        <fieldset disabled={pending.value} class="grid gap-md border-0 p-0 m-0">
          <legend class="sr-only">ACM password</legend>
          {[
            {
              name: "currentPassword",
              label: "Current password",
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
            <div key={field.name} class="grid gap-xs">
              <label for={field.name} class="text-label text-text2">
                {field.label}
              </label>
              <input
                id={field.name}
                name={field.name}
                type="password"
                required
                autoComplete={field.autocomplete}
                class="w-full min-w-0 px-sm py-sm rounded-control bg-surface3 text-text1 border border-border focus:border-border-visible outline-none"
              />
            </div>
          ))}
          <button
            type="submit"
            class="justify-self-start px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer disabled:opacity-50"
          >
            {pending.value ? "Changing password…" : "Change password"}
          </button>
        </fieldset>
        <div aria-live="polite" role="status">
          {result.value && (
            <p
              class={`text-label m-0 ${result.value.ok ? "text-success" : "text-danger"}`}
            >
              {result.value.ok
                ? "Your ACM password was changed."
                : result.value.error}
            </p>
          )}
        </div>
      </form>
    </section>
  );
});
