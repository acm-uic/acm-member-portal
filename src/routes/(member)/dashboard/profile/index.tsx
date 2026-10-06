import { $, component$, useSignal } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, eq } from "drizzle-orm";
import {
  DiscordJoinCta,
  discordLinkButtonClass,
  discordUnlinkButtonClass,
} from "~/components/discord/join-cta";
import { DynamicField } from "~/components/forms/dynamic-field";
import { PasswordChange } from "~/components/forms/password-change";
import { auth } from "~/lib/auth";
import { db } from "~/lib/db";
import { account, auditEvents, memberProfiles, user } from "~/lib/db/schema";
import { identityValues, saveProfile } from "~/lib/profiles/save";
import {
  DISCORD_PROVIDER_ID,
  fetchDiscordIdentity,
  isDiscordConfigured,
} from "~/lib/discord";
import { clearDiscordFromUser } from "~/lib/discord-link";
import { loadPublishedSignupForm } from "~/lib/forms/fields";
import {
  clientFieldErrors,
  valuesFromFormElement,
} from "~/lib/forms/zod-compiler";
import type { PortalSession } from "~/lib/types";

export const useProfileForm = routeLoader$(async ({ sharedMap, url }) => {
  const session = sharedMap.get("session") as PortalSession;
  const [form, [profile], [row]] = await Promise.all([
    loadPublishedSignupForm(),
    db
      .select({
        answers: memberProfiles.answers,
      })
      .from(memberProfiles)
      .where(eq(memberProfiles.userId, session.user.id))
      .limit(1),
    db.select().from(user).where(eq(user.id, session.user.id)).limit(1),
  ]);

  const discordConfigured = isDiscordConfigured();
  let inGuild: boolean | null = null;
  if (discordConfigured && row?.discordId) {
    const [acc] = await db
      .select({ accessToken: account.accessToken })
      .from(account)
      .where(
        and(
          eq(account.userId, session.user.id),
          eq(account.providerId, DISCORD_PROVIDER_ID),
        ),
      )
      .limit(1);
    if (acc?.accessToken) {
      try {
        const ident = await fetchDiscordIdentity(acc.accessToken);
        inGuild = ident.inGuild;
      } catch {
        inGuild = null;
      }
    }
  }

  const justLinked = url.searchParams.get("discord") === "linked";
  const linkFailed = justLinked && !row?.discordId;

  return {
    season: form.season,
    fields: form.fields,
    answers: {
      ...((profile?.answers ?? {}) as Record<string, unknown>),
      ...identityValues(
        row ?? {
          firstName: null,
          lastName: null,
          preferredName: null,
          netid: session.user.netid,
          username: session.user.username,
          uin: null,
          email: session.user.email,
          name: session.user.name,
        },
      ),
    },
    discordConfigured,
    discord: row?.discordId
      ? {
          id: row.discordId,
          username: row.discordUsername,
          inGuild,
        }
      : null,
    linkFailed,
  };
});

export const useUnlinkDiscord = routeAction$(async (_data, event) => {
  const session = event.sharedMap.get("session") as PortalSession | null;
  if (!session?.user) throw event.redirect(302, "/login");

  const [discordAccount] = await db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, session.user.id),
        eq(account.providerId, DISCORD_PROVIDER_ID),
      ),
    )
    .limit(1);

  if (discordAccount) {
    try {
      await auth.api.unlinkAccount({
        body: { accountId: discordAccount.id },
        headers: event.request.headers,
      });
    } catch {
      // Local row may exist without a Better Auth link (copied from signup).
    }
  }

  await db.transaction(async (tx) => {
    await clearDiscordFromUser(tx, session.user.id);
    await tx.insert(auditEvents).values({
      actorId: session.user.id,
      action: "discord.unlink",
      targetType: "user",
      targetId: session.user.id,
    });
  });
  return { ok: true as const };
});

export const useSaveProfile = routeAction$(async (data, { sharedMap }) =>
  saveProfile(data, sharedMap.get("session") as PortalSession),
);

export default component$(() => {
  const profile = useProfileForm();
  const save = useSaveProfile();
  const unlinkDiscord = useUnlinkDiscord();
  const clientErrors = useSignal<Record<string, string>>({});

  const onSubmit$ = $(async (event: Event) => {
    const el = event.target as HTMLFormElement;
    const values = valuesFromFormElement(el, profile.value.fields);
    const errors = clientFieldErrors(profile.value.fields, values);
    clientErrors.value = errors;
    if (Object.keys(errors).length) return;
    await save.submit(new FormData(el));
  });

  const linkDiscord = $(async () => {
    const res = await fetch("/api/auth/link-social", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "discord",
        callbackURL: "/dashboard/profile?discord=linked",
      }),
    });
    const data = (await res.json()) as { url?: string; message?: string };
    if (data.url) window.location.href = data.url;
  });

  const serverErrors = save.value?.ok === false ? save.value.errors : undefined;

  return (
    <main class="p-xl grid gap-lg max-w-2xl">
      <header>
        <h1 class="font-display text-heading m-0">Your profile</h1>
        <p class="text-text2 text-body m-0">
          These are the same fields you filled in at signup. You can update them
          here
          {profile.value.season
            ? `, including anything collected for ${profile.value.season}`
            : ""}
          .
        </p>
      </header>

      {profile.value.discordConfigured && (
        <section class="grid gap-sm bg-discord-subtle border border-discord/40 rounded-component p-md">
          <h2 class="text-subheading text-discord m-0">Discord</h2>
          {profile.value.linkFailed && (
            <p class="text-danger text-label m-0">
              That Discord account is already linked to another member or a
              pending signup.
            </p>
          )}
          {profile.value.discord ? (
            <>
              <p class="text-body text-text1 m-0">
                Linked as{" "}
                <span class="font-mono">
                  @{profile.value.discord.username ?? profile.value.discord.id}
                </span>
              </p>
              <button
                type="button"
                class={discordUnlinkButtonClass}
                onClick$={async () => {
                  await unlinkDiscord.submit();
                }}
              >
                Unlink Discord
              </button>
              {profile.value.discord.inGuild !== true && (
                <DiscordJoinCta prominent />
              )}
            </>
          ) : (
            <>
              <p class="text-text2 text-body m-0">
                Optional. Linking Discord does not sign you in to the portal.
              </p>
              <button
                type="button"
                class={discordLinkButtonClass}
                onClick$={linkDiscord}
              >
                Link Discord
              </button>
            </>
          )}
        </section>
      )}

      <form
        preventdefault:submit
        onSubmit$={onSubmit$}
        class="grid gap-md"
        noValidate
      >
        {profile.value.fields.map((field) => {
          const raw = profile.value.answers[field.key];
          const value = (Array.isArray(raw) ? raw : String(raw ?? "")) as
            string | string[];
          return (
            <DynamicField
              key={field.key}
              field={field}
              value={value}
              error={serverErrors?.[field.key] ?? clientErrors.value[field.key]}
            />
          );
        })}
        <div class="flex items-center gap-md flex-wrap">
          <button
            type="submit"
            class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label cursor-pointer"
          >
            Save changes
          </button>
          {save.value?.ok && (
            <span class="text-success text-label">Saved.</span>
          )}
          {save.value?.ok && save.value.adWarning && (
            <span class="text-warning text-label">
              Saved here, but Active Directory was not updated.{" "}
              {save.value.adWarning}
            </span>
          )}
        </div>
      </form>
      <PasswordChange />
    </main>
  );
});
