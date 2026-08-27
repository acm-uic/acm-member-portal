import { component$ } from "@builder.io/qwik";
import { DISCORD_INVITE_URL } from "~/lib/discord-constants";

export const discordLinkButtonClass =
  "px-md py-sm rounded-control bg-discord text-white border border-discord text-label no-underline cursor-pointer inline-flex w-fit";

export const discordUnlinkButtonClass =
  "px-md py-sm rounded-control bg-transparent text-discord border border-discord text-label cursor-pointer w-fit";

export const DiscordJoinCta = component$((props: { prominent?: boolean }) => {
  if (props.prominent) {
    return (
      <div class="grid gap-xs bg-discord-subtle border border-discord/40 rounded-component p-md">
        <p class="text-body text-text1 m-0">
          You are not in the ACM@UIC Discord yet. Join to get chapter
          announcements and SIG channels.
        </p>
        <a
          href={DISCORD_INVITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class={discordLinkButtonClass}
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
        class="text-discord"
      >
        Join the ACM@UIC server
      </a>
      .
    </p>
  );
});
