import { eq, sql } from "drizzle-orm";
import { db } from "~/lib/db";
import { user } from "~/lib/db/schema";

/**
 * Map a local-dev login identifier to the email Better Auth expects.
 * Emails (contain `@`) are looked up case-insensitively, then passed through
 * so unknown addresses still hit Better Auth's usual error. Usernames are
 * matched exactly first, then case-insensitively.
 */
export async function resolveDevLoginEmail(
	identifier: string,
): Promise<string | null> {
	const trimmed = identifier.trim();
	if (!trimmed) return null;

	if (trimmed.includes("@")) {
		const [row] = await db
			.select({ email: user.email })
			.from(user)
			.where(sql`lower(${user.email}) = ${trimmed.toLowerCase()}`)
			.limit(1);
		return row?.email ?? trimmed;
	}

	const [exact] = await db
		.select({ email: user.email })
		.from(user)
		.where(eq(user.username, trimmed))
		.limit(1);
	if (exact) return exact.email;

	const [folded] = await db
		.select({ email: user.email })
		.from(user)
		.where(sql`lower(${user.username}) = ${trimmed.toLowerCase()}`)
		.limit(1);
	return folded?.email ?? null;
}
