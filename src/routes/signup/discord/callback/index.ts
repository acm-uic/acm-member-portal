import type { RequestHandler } from "@builder.io/qwik-city";
import { db } from "~/lib/db";
import {
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_SIGNUP_COOKIE,
  DISCORD_SIGNUP_COOKIE_MAX_AGE_SEC,
  authCookieSecret,
  cookieSecurity,
  exchangeDiscordCode,
  fetchDiscordIdentity,
  isDiscordConfigured,
  signSignupDiscordCookie,
  signupDiscordCallbackUrl,
} from "~/lib/discord";
import { discordIdTaken } from "~/lib/discord-link";

export const onGet: RequestHandler = async (event) => {
  if (!isDiscordConfigured()) throw event.error(404, "Not found");

  const expected = event.cookie.get(DISCORD_OAUTH_STATE_COOKIE)?.value;
  const state = event.url.searchParams.get("state");
  const oauthCode = event.url.searchParams.get("code");
  event.cookie.delete(DISCORD_OAUTH_STATE_COOKIE, { path: "/" });

  if (event.url.searchParams.get("error")) {
    throw event.redirect(302, "/signup?discord_error=denied");
  }
  if (!oauthCode || !state || !expected || state !== expected) {
    throw event.redirect(302, "/signup?discord_error=failed");
  }

  let identity: {
    user: { id: string; username: string };
    inGuild: boolean | null;
  };
  try {
    const accessToken = await exchangeDiscordCode(
      oauthCode,
      signupDiscordCallbackUrl(),
    );
    identity = await fetchDiscordIdentity(accessToken);
  } catch {
    throw event.redirect(302, "/signup?discord_error=failed");
  }

  const taken = await discordIdTaken(db, identity.user.id);
  if (taken) {
    throw event.redirect(
      302,
      `/signup?discord_error=${encodeURIComponent(taken)}`,
    );
  }

  event.cookie.set(
    DISCORD_SIGNUP_COOKIE,
    signSignupDiscordCookie(
      {
        discordId: identity.user.id,
        username: identity.user.username,
        inGuild: identity.inGuild,
      },
      authCookieSecret(),
    ),
    {
      ...cookieSecurity(),
      maxAge: DISCORD_SIGNUP_COOKIE_MAX_AGE_SEC,
    },
  );

  throw event.redirect(302, "/signup");
};
