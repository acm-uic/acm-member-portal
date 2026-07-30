import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditEvents, userRoles } from "../db/schema";

const MEMBER_ROLE_ID = "00000000-0000-0000-0000-000000000001";
const ALUMNI_ROLE_ID = "00000000-0000-0000-0000-000000000006";

export interface AlumniCandidate {
	userId: string;
	name: string;
	netid: string | null;
	gradYear: number;
	// Index signature lets this type satisfy drizzle's `Record<string, unknown>`
	// constraint on `db.execute<T>` (interference: interfaces don't auto-satisfy
	// string-index signatures, only types do).
	[key: string]: unknown;
}

/**
 * Members eligible for alumni transition (FR11): active, expected grad year
 * within [referenceYear-4, referenceYear], not already alumni. The range
 * predicates compare the raw text expression — valid because grad_year is
 * always a zero-padded 4-digit year (Zod-validated at intake), where text
 * ordering equals numeric ordering — so the member_profiles_grad_year_idx
 * btree is usable. The four-digit guard keeps the SELECT-side ::int
 * display cast safe for legacy/malformed answers.
 */
export async function computeAlumniCandidates(
	referenceYear = new Date().getFullYear(),
): Promise<AlumniCandidate[]> {
	const { rows } = await db.execute<AlumniCandidate>(sql`
		SELECT u.id AS "userId", u.name, u.netid,
		       (mp.answers->>'grad_year')::int AS "gradYear"
		FROM member_profiles mp
		JOIN "user" u ON u.id = mp.user_id
		WHERE mp.status = 'active'
		  AND (mp.answers->>'grad_year') ~ '^\d{4}$'
		  AND (mp.answers->>'grad_year') <= ${String(referenceYear)}
		  AND (mp.answers->>'grad_year') >= ${String(referenceYear - 4)}
		  AND mp.user_id NOT IN (
		    SELECT user_id FROM user_roles WHERE role_id = ${ALUMNI_ROLE_ID}
		  )
		ORDER BY "gradYear" ASC, u.name ASC
	`);
	return rows as unknown as AlumniCandidate[];
}

/** Officer-approved transition: member role → alumni role, audited (FR11). */
export async function transitionToAlumni(
	targetUserId: string,
	actorId: string,
): Promise<void> {
	await db.transaction(async (tx) => {
		await tx
			.delete(userRoles)
			.where(
				and(
					eq(userRoles.userId, targetUserId),
					eq(userRoles.roleId, MEMBER_ROLE_ID),
				),
			);
		await tx
			.insert(userRoles)
			.values({
				userId: targetUserId,
				roleId: ALUMNI_ROLE_ID,
				assignedBy: actorId,
			})
			.onConflictDoNothing();
		await tx.insert(auditEvents).values({
			actorId,
			action: "alumni.approve",
			targetType: "user",
			targetId: targetUserId,
		});
	});
}
