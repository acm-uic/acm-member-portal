import { afterEach, describe, expect, it } from "vitest";
import {
  memberInGuild,
  signSignupDiscordCookie,
  verifySignupDiscordCookie,
  fetchDiscordIdentity,
} from "./discord";

const SECRET = "test-secret-at-least-32-characters!!";

describe("signup Discord cookie", () => {
  it("round-trips a signed identity", () => {
    const now = 1_700_000_000_000;
    const raw = signSignupDiscordCookie(
      { discordId: "1234567890", username: "ada", inGuild: false },
      SECRET,
      now,
    );
    expect(verifySignupDiscordCookie(raw, SECRET, now + 1000)).toEqual({
      discordId: "1234567890",
      username: "ada",
      inGuild: false,
    });
  });

  it("rejects a tampered payload", () => {
    const raw = signSignupDiscordCookie(
      { discordId: "1", username: "ada", inGuild: true },
      SECRET,
    );
    const [body, sig] = raw.split(".");
    const tampered = Buffer.from(
      '{"discordId":"2","username":"ada","inGuild":true,"exp":9999999999999}',
    ).toString("base64url");
    expect(verifySignupDiscordCookie(`${tampered}.${sig}`, SECRET)).toBeNull();
    expect(verifySignupDiscordCookie(`${body}.deadbeef`, SECRET)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    const now = 1_000_000;
    const raw = signSignupDiscordCookie(
      { discordId: "1", username: "ada", inGuild: null },
      SECRET,
      now,
      60,
    );
    expect(verifySignupDiscordCookie(raw, SECRET, now + 61_000)).toBeNull();
  });

  it("rejects a missing secret or value", () => {
    expect(verifySignupDiscordCookie("x.y", "")).toBeNull();
    expect(verifySignupDiscordCookie(null, SECRET)).toBeNull();
  });
});

describe("memberInGuild", () => {
  it("returns null when the guild id is unset", () => {
    expect(memberInGuild([{ id: "1" }], null)).toBeNull();
  });

  it("detects membership from the guild list", () => {
    expect(memberInGuild([{ id: "aaa" }, { id: "bbb" }], "bbb")).toBe(true);
    expect(memberInGuild([{ id: "aaa" }], "bbb")).toBe(false);
  });
});

describe("fetchDiscordIdentity", () => {
  const originalGuild = process.env.DISCORD_GUILD_ID;

  afterEach(() => {
    if (originalGuild === undefined) delete process.env.DISCORD_GUILD_ID;
    else process.env.DISCORD_GUILD_ID = originalGuild;
  });

  it("reads the user and whether they are in the configured guild", async () => {
    process.env.DISCORD_GUILD_ID = "guild-acm";
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/users/@me")) {
        return Response.json({ id: "99", username: "ada" });
      }
      if (url.endsWith("/users/@me/guilds")) {
        return Response.json([{ id: "other" }, { id: "guild-acm" }]);
      }
      return new Response("not found", { status: 404 });
    };
    await expect(fetchDiscordIdentity("token", fetchImpl)).resolves.toEqual({
      user: { id: "99", username: "ada" },
      inGuild: true,
    });
  });

  it("treats membership as unknown when DISCORD_GUILD_ID is unset", async () => {
    delete process.env.DISCORD_GUILD_ID;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/users/@me")) {
        return Response.json({ id: "99", username: "ada" });
      }
      if (url.endsWith("/users/@me/guilds")) {
        return Response.json([{ id: "guild-acm" }]);
      }
      return new Response("not found", { status: 404 });
    };
    await expect(fetchDiscordIdentity("token", fetchImpl)).resolves.toEqual({
      user: { id: "99", username: "ada" },
      inGuild: null,
    });
  });
});
