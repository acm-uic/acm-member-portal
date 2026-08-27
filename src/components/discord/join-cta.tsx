import { component$ } from "@builder.io/qwik";
import { DISCORD_INVITE_URL } from "~/lib/discord-constants";

export const DiscordJoinCta = component$((props: { prominent?: boolean }) => {
  if (props.prominent) {
    return (
      <div class="grid gap-xs bg-surface2 border border-border rounded-component p-md">
        <p class="text-body text-text1 m-0">
          You are not in the ACM@UIC Discord yet. Join to get chapter
          announcements and SIG channels.
        </p>
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="px-md py-sm rounded-control bg-accent text-white border border-accent text-label no-underline cursor-pointer inline-flex w-fit"
        >
          Join the ACM@UIC Discord
        </a>
      </div>
    );
  }
  return (
    <p class="text-text2 text-body m-0">
      Not on Discord yet?{" "}
      <a
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        class="text-accent"
      >
        Join the ACM@UIC server
      </a>
      .
    </p>
  );
});
