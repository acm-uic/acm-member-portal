import { component$, useVisibleTask$ } from "@builder.io/qwik";
import { Link, useLocation } from "@builder.io/qwik-city";
import { DiscordJoinCta } from "~/components/discord/join-cta";
import { clearSignupDraft } from "~/lib/signup-draft";

export default component$(() => {
  const loc = useLocation();
  const linked = loc.url.searchParams.get("discord") === "1";
  const inGuild = loc.url.searchParams.get("inGuild");
  const showJoin = !linked || inGuild !== "1";

  useVisibleTask$(() => {
    clearSignupDraft();
  });

  return (
    <main class="min-h-screen grid place-items-center p-xl">
      <div class="max-w-md w-full min-w-0 bg-surface1 border border-border rounded-component shadow-card p-xl grid gap-md">
        <p class="m-0 inline-flex w-fit px-sm py-2xs rounded-element bg-success-bg text-success text-label">
          Signup received
        </p>
        <h1 class="font-display text-heading m-0">Pending review</h1>
        <p class="text-text2 text-body m-0">
          An officer will review your signup. Once approved, your ACM account
          will be created. An officer will give you a username and temporary
          password, or send them to your personal email address.
        </p>
        <p class="text-text2 text-body m-0">
          When you receive your credentials,{" "}
          <Link href="/activate/" class="text-accent underline">
            activate your account
          </Link>{" "}
          and choose a new password. Allow up to 30 minutes for it to
          synchronize, then{" "}
          <Link href="/login/" class="text-accent underline">
            sign in with Microsoft
          </Link>{" "}
          using your ACM email address and new password.
        </p>
        {linked && inGuild !== "1" ? (
          <DiscordJoinCta prominent />
        ) : showJoin ? (
          <DiscordJoinCta />
        ) : null}
        <Link href="/" class="text-accent text-label no-underline">
          Back to home
        </Link>
      </div>
    </main>
  );
});
