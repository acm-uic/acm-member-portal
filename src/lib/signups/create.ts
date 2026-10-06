import { db } from "../db";
import { signupSubmissions } from "../db/schema";
import { signupUsernameConflictErrors } from "./conflicts";

export async function createPendingSignup(
  submission: typeof signupSubmissions.$inferInsert,
): Promise<{ ok: true } | { ok: false; errors: Record<string, string> }> {
  try {
    await db
      .insert(signupSubmissions)
      .values({ ...submission, status: "pending" });
    return { ok: true };
  } catch (error) {
    const errors = signupUsernameConflictErrors(error);
    if (errors) return { ok: false, errors };
    throw error;
  }
}
