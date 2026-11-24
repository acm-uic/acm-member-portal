import { and, eq, exists, isNull, ne, sql } from "drizzle-orm";
import { microsoft, type MicrosoftOptions } from "better-auth/social-providers";
import { z } from "zod";
import type { PortalDb } from "./db/index.ts";
import { account, user } from "./db/schema.ts";
import { mapMicrosoftProfileToUser } from "./microsoft-profile.ts";

const objectId = z.guid();
const emailAddress = z.string().trim().toLowerCase().pipe(z.email());
const directoryProfile = z.object({
  id: z.string(),
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
});

function email(value: unknown) {
  return emailAddress.safeParse(value).data;
}

async function getDirectoryProfile(oid: string, accessToken?: string) {
  if (!accessToken) return;
  try {
    const response = await fetch(
      "https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      },
    );
    if (response.ok) {
      const profile = directoryProfile.safeParse(await response.json()).data;
      if (profile?.id.toLowerCase() === oid.toLowerCase()) return profile;
    }
    console.warn(
      "Microsoft sign-in could not read the matching Graph profile.",
    );
  } catch {
    console.warn("Microsoft sign-in could not reach Microsoft Graph.");
  }
}

function isEmailConflict(error: unknown) {
  const details = (error as { cause?: unknown } | null)?.cause ?? error;
  const { code, constraint } = (details ?? {}) as {
    code?: string;
    constraint?: string;
  };
  return (
    code === "23505" &&
    (constraint === "user_email_key" || constraint === "user_email_unique")
  );
}

export function microsoftWithEmailReconciliation(
  db: PortalDb,
  options: MicrosoftOptions,
): MicrosoftOptions {
  const tenantId = objectId.safeParse(options.tenantId).data?.toLowerCase();
  const { getUserInfo } = microsoft({
    ...options,
    mapProfileToUser: mapMicrosoftProfileToUser,
  });

  return {
    ...options,
    async getUserInfo(tokens) {
      const info = await getUserInfo(tokens);
      if (!info) return null;
      const { oid, tid, preferred_username, upn } = info.data;
      if (
        !tenantId ||
        typeof tid !== "string" ||
        tid.toLowerCase() !== tenantId ||
        !objectId.safeParse(oid).success
      ) {
        return null;
      }

      const graph = await getDirectoryProfile(oid, tokens.accessToken);
      const directoryEmail = email(graph?.mail);
      const tokenEmail = email(info.data.email);
      const loginEmail =
        email(graph?.userPrincipalName) ??
        email(preferred_username) ??
        email(upn);
      const microsoftAccount = and(
        eq(account.providerId, "microsoft"),
        eq(account.accountId, oid),
      );
      const [linked] = await db
        .select({
          id: user.id,
          email: user.email,
          entraSyncedEmail: user.entraSyncedEmail,
        })
        .from(account)
        .innerJoin(user, eq(account.userId, user.id))
        .where(microsoftAccount);

      async function emailInUse(address: string, userId?: string) {
        const [holder] = await db
          .select({ id: user.id })
          .from(user)
          .where(
            and(
              sql`lower(${user.email}) = ${address}`,
              userId === undefined ? undefined : ne(user.id, userId),
            ),
          )
          .limit(1);
        return Boolean(holder);
      }

      let portalEmail = linked?.email;
      if (linked) {
        // A profile edit can reach the portal before it reaches Entra.
        const pendingEdit =
          linked.entraSyncedEmail !== null &&
          linked.entraSyncedEmail !== linked.email;
        if (
          directoryEmail &&
          directoryEmail !== linked.entraSyncedEmail &&
          (!pendingEdit || directoryEmail === email(linked.email)) &&
          !(await emailInUse(directoryEmail, linked.id))
        ) {
          try {
            const [updated] = await db
              .update(user)
              .set({
                email: directoryEmail,
                entraSyncedEmail: directoryEmail,
                emailVerified:
                  directoryEmail === linked.email ? undefined : false,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(user.id, linked.id),
                  eq(user.email, linked.email),
                  linked.entraSyncedEmail === null
                    ? isNull(user.entraSyncedEmail)
                    : eq(user.entraSyncedEmail, linked.entraSyncedEmail),
                  exists(
                    db
                      .select({ id: account.id })
                      .from(account)
                      .where(
                        and(microsoftAccount, eq(account.userId, linked.id)),
                      ),
                  ),
                ),
              )
              .returning({ email: user.email });
            portalEmail = updated?.email ?? portalEmail;
          } catch (error) {
            if (!isEmailConflict(error)) throw error;
          }
        }
      } else {
        const contact = graph ? directoryEmail : tokenEmail;
        if (contact && !(await emailInUse(contact))) portalEmail = contact;
        else if (loginEmail && !(await emailInUse(loginEmail)))
          portalEmail = loginEmail;
      }

      return {
        ...info,
        user: {
          ...info.user,
          email: portalEmail,
          emailVerified: Boolean(
            portalEmail &&
            portalEmail === directoryEmail &&
            portalEmail === tokenEmail &&
            info.user.emailVerified,
          ),
        },
      };
    },
  };
}
