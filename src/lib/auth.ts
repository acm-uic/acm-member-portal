import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { isDevLoginEnabled, isEmbeddedDb } from "./db/mode.ts";
import {
  account,
  auditEvents,
  session,
  user,
  verification,
} from "./db/schema.ts";
import { bootstrapUser } from "./auth-bootstrap.ts";
import { mapMicrosoftProfileToUser } from "./microsoft-profile.ts";
import {
  DISCORD_PROVIDER_ID,
  DISCORD_SCOPES,
  fetchDiscordIdentity,
  isDiscordConfigured,
} from "./discord.ts";
import { discordIdTaken } from "./discord-link.ts";

/** Local-only defaults — never applied in production. */
function ensureDevAuthEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  if (!process.env.BETTER_AUTH_SECRET) {
    process.env.BETTER_AUTH_SECRET =
      "local-dev-secret-not-for-production-use-32b";
  }
  if (!process.env.BETTER_AUTH_URL) {
    process.env.BETTER_AUTH_URL = "http://localhost:5173";
  }
  if (!process.env.ORIGIN) {
    process.env.ORIGIN = "http://localhost:5173";
  }
}

if (isEmbeddedDb() || isDevLoginEnabled()) {
  ensureDevAuthEnv();
}

const microsoftConfigured = Boolean(process.env.MICROSOFT_CLIENT_ID);
const discordConfigured = isDiscordConfigured();
const devLogin = isDevLoginEnabled();

function netidFromEmail(email: string): string | null {
  const local = email.split("@")[0]?.trim();
  return local || null;
}

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL!,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: devLogin
    ? {
        enabled: true,
      }
    : undefined,
  session: {
    cookieCache: { enabled: true, maxAge: 300 },
  },
  user: {
    additionalFields: {
      netid: { type: "string", required: false },
      username: { type: "string", required: false },
      uin: { type: "string", required: false },
      firstName: { type: "string", required: false },
      lastName: { type: "string", required: false },
      preferredName: { type: "string", required: false },
      displayName: { type: "string", required: false },
      entraOid: { type: "string", required: false },
      discordId: { type: "string", required: false },
      discordUsername: { type: "string", required: false },
    },
  },
  account: {
    additionalFields: {
      // Better Auth 1.7 core field. Declared here so a hoisted
      // @better-auth/core@1.6.x adapter still persists issuer on insert.
      issuer: { type: "string", required: true },
    },
    accountLinking: {
      enabled: true,
      trustedProviders: microsoftConfigured ? ["microsoft"] : [],
      allowDifferentEmails: true,
    },
  },
  socialProviders: {
    ...(microsoftConfigured
      ? {
          microsoft: {
            clientId: process.env.MICROSOFT_CLIENT_ID!,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
            tenantId: process.env.MICROSOFT_TENANT_ID!,
            prompt: "select_account" as const,
            disableProfilePhoto: true,
            mapProfileToUser: mapMicrosoftProfileToUser,
          },
        }
      : {}),
    ...(discordConfigured
      ? {
          discord: {
            clientId: process.env.DISCORD_CLIENT_ID!,
            clientSecret: process.env.DISCORD_CLIENT_SECRET!,
            disableSignUp: true,
            disableDefaultScope: true,
            scope: [...DISCORD_SCOPES],
            prompt: "consent" as const,
            mapProfileToUser: (profile: { id: string; username: string }) => ({
              discordId: profile.id,
              discordUsername: profile.username,
            }),
          },
        }
      : {}),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (created) => {
          const existingNetid =
            (created as { netid?: string | null }).netid ?? null;
          const netid =
            existingNetid ?? (devLogin ? netidFromEmail(created.email) : null);

          if (netid && !existingNetid) {
            await db.update(user).set({ netid }).where(eq(user.id, created.id));
          }

          await bootstrapUser({
            id: created.id,
            email: created.email,
            netid,
            displayName:
              (created as { displayName?: string | null }).displayName ??
              created.name,
          });
        },
      },
    },
    account: {
      create: {
        before: async (created) => {
          const createdAccount = created as typeof created & {
            issuer?: string | null;
          };
          if (createdAccount.issuer) return;

          return {
            data: {
              ...created,
              issuer:
                created.providerId === "credential"
                  ? "local:credential"
                  : `local:oauth:${created.providerId}`,
            },
          };
        },
        after: async (created) => {
          if (created.providerId !== DISCORD_PROVIDER_ID) return;

          const taken = await discordIdTaken(
            db,
            created.accountId,
            created.userId,
          );
          if (taken) {
            await db.delete(account).where(eq(account.id, created.id));
            await db
              .update(user)
              .set({
                discordId: null,
                discordUsername: null,
                updatedAt: new Date(),
              })
              .where(eq(user.id, created.userId));
            return;
          }

          let username: string | null = null;
          if (created.accessToken) {
            try {
              const ident = await fetchDiscordIdentity(created.accessToken);
              username = ident.user.username;
            } catch {
              username = null;
            }
          }
          const [existing] = await db
            .select({ discordUsername: user.discordUsername })
            .from(user)
            .where(eq(user.id, created.userId))
            .limit(1);
          const discordUsername = username ?? existing?.discordUsername ?? null;
          await db
            .update(user)
            .set({
              discordId: created.accountId,
              discordUsername,
              updatedAt: new Date(),
            })
            .where(eq(user.id, created.userId));
          await db.insert(auditEvents).values({
            actorId: created.userId,
            action: "discord.link",
            targetType: "user",
            targetId: created.userId,
            after: {
              discordId: created.accountId,
              discordUsername,
            },
          });
        },
      },
    },
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
    ipAddress: { ipAddressHeaders: ["x-real-ip", "x-forwarded-for"] },
  },
});

export { microsoftConfigured, discordConfigured, devLogin };
