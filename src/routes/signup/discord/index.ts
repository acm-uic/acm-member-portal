import type { RequestHandler } from "@builder.io/qwik-city";
import {
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_OAUTH_STATE_MAX_AGE_SEC,
  cookieSecurity,
  discordAuthorizeUrl,
  isDiscordConfigured,
  newOAuthState,
  signupDiscordCallbackUrl,
} from "~/lib/discord";

export const onGet: RequestHandler = (event) => {
  if (!isDiscordConfigured()) throw event.error(404, "Not found");
  const state = newOAuthState();
  event.cookie.set(DISCORD_OAUTH_STATE_COOKIE, state, {
    ...cookieSecurity(),
    maxAge: DISCORD_OAUTH_STATE_MAX_AGE_SEC,
  });
  throw event.redirect(
    302,
    discordAuthorizeUrl(state, signupDiscordCallbackUrl()),
  );
};
