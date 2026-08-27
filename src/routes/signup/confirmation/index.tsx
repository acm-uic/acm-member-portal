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
          An officer will review your signup. Once approved, your ACM Microsoft
          account is created and your sign-in details are emailed to your
          personal address.
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
