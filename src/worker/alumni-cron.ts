import { eq } from "drizzle-orm";
import { computeAlumniCandidates } from "../lib/alumni/suggestions";
import { db } from "../lib/db";
import { user, userRoles } from "../lib/db/schema";
import { sendMail } from "../lib/mail/smtp";

const OFFICER_ROLE_ID = "00000000-0000-0000-0000-000000000002";

/**
 * Nightly CronJob entrypoint: emails officers the list of members eligible
 * for alumni transition. No suggestion table — candidates are computed
 * on demand (the expression index makes this cheap). Silent no-op when
 * there is nothing to report.
 */
export async function runAlumniDigest(): Promise<void> {
	const candidates = await computeAlumniCandidates();
	if (candidates.length === 0) {
		console.log("alumni digest: no candidates");
		return;
	}

	const officers = await db
		.select({ email: user.email })
		.from(userRoles)
		.innerJoin(user, eq(userRoles.userId, user.id))
		.where(eq(userRoles.roleId, OFFICER_ROLE_ID));

	if (officers.length === 0) {
		console.log("alumni digest: no officers to notify");
		return;
	}

	const lines = candidates.map(
		(c) => `  ${c.name} (${c.netid ?? "no netid"}) — class of ${c.gradYear}`,
	);

	await sendMail({
		to: officers.map((o) => o.email).join(", "),
		subject: `${candidates.length} member${candidates.length === 1 ? "" : "s"} eligible for alumni transition`,
		text: [
			"The following active members have an expected graduation year that has passed:",
			"",
			...lines,
			"",
			"Review and approve the transitions at https://portal.acm-uic.org/admin/alumni",
			"",
			"— ACM@UIC member portal",
		].join("\n"),
	});

	console.log(
		`alumni digest: sent for ${candidates.length} candidate(s) to ${officers.length} officer(s)`,
	);
}
