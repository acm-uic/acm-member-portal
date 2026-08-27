/** Public Discord constants. Safe to import from client components. */

export const DISCORD_INVITE_URL = "https://acm.cs.uic.edu/discord";
export const DISCORD_PROVIDER_ID = "discord";
export const DISCORD_SCOPES = ["identify", "guilds"] as const;
export const DISCORD_SIGNUP_COOKIE = "portal_discord_signup";
export const DISCORD_OAUTH_STATE_COOKIE = "portal_discord_oauth_state";
export const DISCORD_SIGNUP_COOKIE_MAX_AGE_SEC = 60 * 60;
export const DISCORD_OAUTH_STATE_MAX_AGE_SEC = 10 * 60;
