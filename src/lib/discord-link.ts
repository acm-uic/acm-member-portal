import { and, eq, ne } from "drizzle-orm";
import { db } from "~/lib/db";
import { account, signupSubmissions, user } from "~/lib/db/schema";
import { DISCORD_PROVIDER_ID } from "~/lib/discord-constants";

export type DiscordTakenReason = "user" | "pending";

type SelectDb = Pick<typeof db, "select">;

export async function discordIdTaken(
  database: SelectDb,
  discordId: string,
  exceptUserId?: string | null,
): Promise<DiscordTakenReason | null> {
  const userFilter = exceptUserId
    ? and(eq(user.discordId, discordId), ne(user.id, exceptUserId))
    : eq(user.discordId, discordId);
  const [existing] = await database
    .select({ id: user.id })
    .from(user)
    .where(userFilter)
    .limit(1);
  if (existing) return "user";

  const [pending] = await database
    .select({ id: signupSubmissions.id })
    .from(signupSubmissions)
    .where(
      and(
        eq(signupSubmissions.discordId, discordId),
        eq(signupSubmissions.status, "pending"),
      ),
    )
    .limit(1);
  if (pending) return "pending";
  return null;
}

export function discordTakenMessage(reason: DiscordTakenReason): string {
  return reason === "pending"
    ? "This Discord account is already on a pending signup."
    : "This Discord account is already linked to another member.";
}

type MutatingDb = Pick<typeof db, "insert" | "update" | "delete">;

export async function insertDiscordAccount(
  database: MutatingDb,
  userId: string,
  discordId: string,
): Promise<void> {
  await database
    .insert(account)
    .values({
      id: crypto.randomUUID(),
      userId,
      accountId: discordId,
      providerId: DISCORD_PROVIDER_ID,
    })
    .onConflictDoNothing();
}

export async function clearDiscordFromUser(
  database: MutatingDb,
  userId: string,
): Promise<void> {
  await database
    .delete(account)
    .where(
      and(
        eq(account.userId, userId),
        eq(account.providerId, DISCORD_PROVIDER_ID),
      ),
    );
  await database
    .update(user)
    .set({
      discordId: null,
      discordUsername: null,
      updatedAt: new Date(),
    })
    .where(eq(user.id, userId));
}
