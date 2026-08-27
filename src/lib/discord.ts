import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DISCORD_PROVIDER_ID,
  DISCORD_SCOPES,
  DISCORD_SIGNUP_COOKIE_MAX_AGE_SEC,
} from "~/lib/discord-constants";

export {
  DISCORD_INVITE_URL,
  DISCORD_OAUTH_STATE_COOKIE,
  DISCORD_OAUTH_STATE_MAX_AGE_SEC,
  DISCORD_PROVIDER_ID,
  DISCORD_SCOPES,
  DISCORD_SIGNUP_COOKIE,
  DISCORD_SIGNUP_COOKIE_MAX_AGE_SEC,
} from "~/lib/discord-constants";

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_AUTHORIZE = "https://discord.com/oauth2/authorize";

export function isDiscordConfigured(): boolean {
  return Boolean(
    process.env.DISCORD_CLIENT_ID?.trim() &&
    process.env.DISCORD_CLIENT_SECRET?.trim(),
  );
}

export function discordGuildId(): string | null {
  const id = process.env.DISCORD_GUILD_ID?.trim();
  return id || null;
}

export function publicOrigin(): string {
  return (
    process.env.ORIGIN?.replace(/\/$/, "") ||
    process.env.BETTER_AUTH_URL?.replace(/\/$/, "") ||
    "http://localhost:5173"
  );
}

export function signupDiscordCallbackUrl(): string {
  return `${publicOrigin()}/signup/discord/callback`;
}

export function discordAuthorizeUrl(
  state: string,
  redirectUri: string,
): string {
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DISCORD_SCOPES.join(" "),
    state,
    prompt: "consent",
  });
  return `${DISCORD_AUTHORIZE}?${params}`;
}

export function newOAuthState(): string {
  return randomBytes(16).toString("hex");
}

export type SignupDiscordIdentity = {
  discordId: string;
  username: string;
  inGuild: boolean | null;
};

type SignupCookiePayload = SignupDiscordIdentity & { exp: number };

export function signSignupDiscordCookie(
  identity: SignupDiscordIdentity,
  secret: string,
  now = Date.now(),
  maxAgeSec = DISCORD_SIGNUP_COOKIE_MAX_AGE_SEC,
): string {
  const payload: SignupCookiePayload = {
    ...identity,
    exp: now + maxAgeSec * 1000,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySignupDiscordCookie(
  raw: string | undefined | null,
  secret: string,
  now = Date.now(),
): SignupDiscordIdentity | null {
  if (!raw || !secret) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SignupCookiePayload;
    if (
      typeof payload.discordId !== "string" ||
      !payload.discordId ||
      typeof payload.username !== "string" ||
      !payload.username ||
      typeof payload.exp !== "number"
    ) {
      return null;
    }
    if (payload.exp < now) return null;
    const inGuild =
      payload.inGuild === true
        ? true
        : payload.inGuild === false
          ? false
          : null;
    return {
      discordId: payload.discordId,
      username: payload.username,
      inGuild,
    };
  } catch {
    return null;
  }
}

export function authCookieSecret(): string {
  return process.env.BETTER_AUTH_SECRET ?? "";
}

export function cookieSecurity(): {
  httpOnly: true;
  path: "/";
  sameSite: "lax";
  secure: boolean;
} {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  };
}

export function memberInGuild(
  guilds: readonly { id: string }[],
  guildId: string | null,
): boolean | null {
  if (!guildId) return null;
  return guilds.some((g) => g.id === guildId);
}

export async function exchangeDiscordCode(
  code: string,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID ?? "",
    client_secret: process.env.DISCORD_CLIENT_SECRET ?? "",
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Discord token exchange failed (${res.status})`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Discord token exchange returned no access_token");
  }
  return json.access_token;
}

export async function fetchDiscordIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{
  user: { id: string; username: string };
  inGuild: boolean | null;
}> {
  const headers = { authorization: `Bearer ${accessToken}` };
  const meRes = await fetchImpl(`${DISCORD_API}/users/@me`, { headers });
  if (!meRes.ok) {
    throw new Error(`Discord identify failed (${meRes.status})`);
  }
  const me = (await meRes.json()) as { id?: string; username?: string };
  if (!me.id || !me.username) {
    throw new Error("Discord identify returned no user");
  }

  const guildsRes = await fetchImpl(`${DISCORD_API}/users/@me/guilds`, {
    headers,
  });
  let inGuild: boolean | null = null;
  if (guildsRes.ok) {
    const guilds = (await guildsRes.json()) as { id: string }[];
    inGuild = memberInGuild(
      Array.isArray(guilds) ? guilds : [],
      discordGuildId(),
    );
  }
  return { user: { id: me.id, username: me.username }, inGuild };
}
