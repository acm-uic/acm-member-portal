import { and, eq, ne, or, isNull } from "drizzle-orm";
import type { PortalDb } from "./db/index.ts";
import { usernameClaims } from "./db/schema.ts";

type Transaction = Parameters<Parameters<PortalDb["transaction"]>[0]>[0];

/** Only account bootstrap may attach an existing user to its approved signup. */
export async function attachApprovedSignupClaim(
  tx: Transaction,
  submission: { id: string; username: string },
  userId: string,
) {
  await tx
    .update(usernameClaims)
    .set({ userId: null })
    .where(
      and(
        eq(usernameClaims.userId, userId),
        ne(usernameClaims.username, submission.username),
      ),
    );
  const [claim] = await tx
    .update(usernameClaims)
    .set({ userId })
    .where(
      and(
        eq(usernameClaims.username, submission.username),
        eq(usernameClaims.signupSubmissionId, submission.id),
        or(isNull(usernameClaims.userId), eq(usernameClaims.userId, userId)),
      ),
    )
    .returning();
  if (!claim) {
    throw Object.assign(new Error("Username is already claimed"), {
      code: "23505",
      constraint: "username_claims_username_key",
    });
  }
}
