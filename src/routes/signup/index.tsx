import { $, component$, useSignal, useVisibleTask$ } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, eq } from "drizzle-orm";
import { DiscordJoinCta } from "~/components/discord/join-cta";
import { DynamicField } from "~/components/forms/dynamic-field";
import { ThemeToggle } from "~/components/theme-toggle";
import { db } from "~/lib/db";
import { signupSubmissions, user } from "~/lib/db/schema";
import {
  DISCORD_SIGNUP_COOKIE,
  authCookieSecret,
  isDiscordConfigured,
  verifySignupDiscordCookie,
} from "~/lib/discord";
import { discordIdTaken, discordTakenMessage } from "~/lib/discord-link";
import { loadPublishedSignupForm } from "~/lib/forms/fields";
import type { FormFieldDef } from "~/lib/types";
import {
  loadSignupDraft,
  saveSignupDraft,
} from "~/lib/signup-draft";
import {
  clientFieldErrors,
  compileFormSchema,
  flattenFieldErrors,
  postedValues,
  splitAnswers,
  valuesFromFormElement,
} from "~/lib/forms/zod-compiler";

function discordErrorMessage(code: string | null): string | undefined {
  if (!code) return undefined;
  if (code === "denied") return "Discord authorization was cancelled.";
  if (code === "user" || code === "pending") return discordTakenMessage(code);
  return "Discord linking failed. You can try again or skip it.";
}

/**
 * PUBLIC route — no session check (FR1/FR2: accounts do not exist until
 * after officer approval). Discord identity is read from a signed cookie,
 * not from the posted form.
 */
export const useSignupForm = routeLoader$(async (event) => {
  const form = await loadPublishedSignupForm();
  const discordConfigured = isDiscordConfigured();
  const discord = discordConfigured
    ? verifySignupDiscordCookie(
        event.cookie.get(DISCORD_SIGNUP_COOKIE)?.value,
        authCookieSecret(),
      )
    : null;
  return {
    season: form.season,
    fields: form.fields,
    discordConfigured,
    discord,
    discordError: discordErrorMessage(
      event.url.searchParams.get("discord_error"),
    ),
  };
});

export const useClearSignupDiscord = routeAction$(async (_data, event) => {
  event.cookie.delete(DISCORD_SIGNUP_COOKIE, { path: "/" });
  throw event.redirect(302, "/signup");
});

export const useSubmitSignup = routeAction$(async (data, event) => {
  const form = await loadPublishedSignupForm();
  const parsed = compileFormSchema(form.fields).safeParse(data);
  if (!parsed.success) {
    return {
      ok: false as const,
      errors: flattenFieldErrors(parsed.error.flatten().fieldErrors),
      values: postedValues(data),
    };
  }

  const { base, answers } = splitAnswers(parsed.data);

  const discord = isDiscordConfigured()
    ? verifySignupDiscordCookie(
        event.cookie.get(DISCORD_SIGNUP_COOKIE)?.value,
        authCookieSecret(),
      )
    : null;

  const [pendingNetid] = await db
    .select({ id: signupSubmissions.id })
    .from(signupSubmissions)
    .where(
      and(
        eq(signupSubmissions.netid, base.netid),
        eq(signupSubmissions.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingNetid) {
    return {
      ok: false as const,
      errors: { netid: "A signup with this NetID is already pending review." },
      values: postedValues(data),
    };
  }

  const [pendingUsername] = await db
    .select({ id: signupSubmissions.id })
    .from(signupSubmissions)
    .where(
      and(
        eq(signupSubmissions.username, base.username),
        eq(signupSubmissions.status, "pending"),
      ),
    )
    .limit(1);
  if (pendingUsername) {
    return {
      ok: false as const,
      errors: {
        username: "A signup with this username is already pending review.",
      },
      values: postedValues(data),
    };
  }

  const [takenUsername] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.username, base.username))
    .limit(1);
  if (takenUsername) {
    return {
      ok: false as const,
      errors: { username: "This username is already in use." },
      values: postedValues(data),
    };
  }

  if (discord) {
    const taken = await discordIdTaken(db, discord.discordId);
    if (taken) {
      return {
        ok: false as const,
        errors: { discord: discordTakenMessage(taken) },
        values: postedValues(data),
      };
    }
  }

  const preferred = base.preferred_name?.trim() || null;
  await db.insert(signupSubmissions).values({
    schemaVersionId: form.schemaVersionId,
    firstName: base.first_name,
    lastName: base.last_name,
    preferredName: preferred,
    netid: base.netid,
    username: base.username,
    uin: base.uin,
    email: base.email,
    answers,
    discordId: discord?.discordId ?? null,
    discordUsername: discord?.username ?? null,
    discordInGuild: discord ? discord.inGuild : null,
  });

  event.cookie.delete(DISCORD_SIGNUP_COOKIE, { path: "/" });

  const confirm = new URLSearchParams();
  if (discord) {
    confirm.set("discord", "1");
    if (discord.inGuild === true) confirm.set("inGuild", "1");
    else if (discord.inGuild === false) confirm.set("inGuild", "0");
  }
  const qs = confirm.toString();
  throw event.redirect(303, `/signup/confirmation${qs ? `?${qs}` : ""}`);
});

function snapshotSignupForm(fields: FormFieldDef[]): void {
  const el = document.getElementById("signup-form") as HTMLFormElement | null;
  if (!el) return;
  saveSignupDraft(valuesFromFormElement(el, fields));
}

export default component$(() => {
  const form = useSignupForm();
  const action = useSubmitSignup();
  const clearDiscord = useClearSignupDiscord();
  const clientErrors = useSignal<Record<string, string>>({});
  const draft = useSignal<Record<string, string | string[]> | undefined>(
    undefined,
  );

  useVisibleTask$(() => {
    draft.value = loadSignupDraft() ?? undefined;
  });

  const onSubmit$ = $(async (event: Event) => {
    const el = event.target as HTMLFormElement;
    const values = valuesFromFormElement(el, form.value.fields);
    const errors = clientFieldErrors(form.value.fields, values);
    clientErrors.value = errors;
    if (Object.keys(errors).length) return;
    saveSignupDraft(values);
    await action.submit(new FormData(el));
  });

  const linkDiscord = $(() => {
    snapshotSignupForm(form.value.fields);
    window.location.href = "/signup/discord";
  });

  const unlinkDiscord = $(async () => {
    snapshotSignupForm(form.value.fields);
    await clearDiscord.submit();
  });

  const values = action.value?.ok === false ? action.value.values : draft.value;
  const serverErrors =
    action.value?.ok === false ? action.value.errors : undefined;

  return (
    <main class="min-h-screen grid place-items-center p-xl">
      <div class="absolute top-md right-md">
        <ThemeToggle />
      </div>
      <div class="max-w-lg w-full min-w-0 bg-surface1 border border-border rounded-component shadow-card p-xl grid gap-lg">
        <header class="grid gap-xs">
          <h1 class="font-display text-heading m-0">
            Join <span class="text-accent">ACM</span>@UIC
          </h1>
          <p class="text-text2 text-body m-0">
            {form.value.season
              ? `Membership signup for ${form.value.season}. `
              : ""}
            An officer reviews every signup; your ACM account is created after
            approval.
          </p>
        </header>

        <form
          id="signup-form"
          preventdefault:submit
          onSubmit$={onSubmit$}
          class="grid gap-md min-w-0"
          noValidate
        >
          {form.value.fields.map((field) => (
            <DynamicField
              key={field.key}
              field={field}
              value={values?.[field.key]}
              error={serverErrors?.[field.key] ?? clientErrors.value[field.key]}
            />
          ))}

          {form.value.discordConfigured && (
            <div class="grid gap-sm">
              <p class="text-label text-text2 m-0">Discord (optional)</p>
              {form.value.discordError && (
                <p class="text-danger text-label m-0">
                  {form.value.discordError}
                </p>
              )}
              {serverErrors?.discord && (
                <p class="text-danger text-label m-0">{serverErrors.discord}</p>
              )}
              {form.value.discord ? (
                <>
                  <p class="text-body text-text1 m-0">
                    Linked as{" "}
                    <span class="font-mono">
                      @{form.value.discord.username}
                    </span>
                  </p>
                  <button
                    type="button"
                    class="px-md py-sm rounded-control bg-transparent text-text1 border border-border-visible text-label cursor-pointer w-fit"
                    onClick$={unlinkDiscord}
                  >
                    Unlink Discord
                  </button>
                  {form.value.discord.inGuild !== true && (
                    <DiscordJoinCta prominent />
                  )}
                </>
              ) : (
                <button
                  type="button"
                  class="px-md py-sm rounded-control bg-transparent text-text1 border border-border-visible text-label cursor-pointer inline-flex w-fit"
                  onClick$={linkDiscord}
                >
                  Link Discord
                </button>
              )}
            </div>
          )}

          <button
            type="submit"
            class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
          >
            Submit signup
          </button>
        </form>
      </div>
    </main>
  );
});
