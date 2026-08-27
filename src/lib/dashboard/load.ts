import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { computeAlumniCandidates } from "~/lib/alumni/suggestions";
import { db } from "~/lib/db";
import {
	contentItems,
	memberProfiles,
	roles,
	sigLeaders,
	sigs,
	signupSubmissions,
	user,
	userRoles,
} from "~/lib/db/schema";
import type { PermissionKey } from "~/lib/rbac/permissions";
import type { DashboardView } from "./view";

export const OFFICER_ROLE_ID = "00000000-0000-0000-0000-000000000002";
export const CHART_WEEKS = 20;

export type AnnouncementItem = {
	id: string;
	date: Date;
	title: string;
	subtitle: string;
};

export type TableRow = { cells: string[] };

export type PersonalMetrics = {
	membership: string;
	provisioning: {
		note: string;
		tone: "success" | "warning" | "error";
	};
	sigCount: number;
	gradYear: number | null;
};

export type SigInterestGroup = {
	sigId: string;
	sigKey: string;
	displayName: string;
	interestCount: number;
	members: TableRow[];
};

export type StaffShortcut = { href: string; label: string };

async function loadAnnouncements(limit = 5): Promise<AnnouncementItem[]> {
	const rows = await db
		.select({
			id: contentItems.id,
			title: contentItems.title,
			publishedAt: contentItems.publishedAt,
		})
		.from(contentItems)
		.where(
			and(
				eq(contentItems.status, "published"),
				eq(contentItems.type, "announcement"),
			),
		)
		.orderBy(desc(contentItems.publishedAt))
		.limit(limit);

	return rows.map((a) => ({
		id: a.id,
		date: a.publishedAt ?? new Date(0),
		title: a.title,
		subtitle: "Chapter announcement",
	}));
}

async function loadOfficers(limit = 8): Promise<TableRow[]> {
	const officers = await db
		.select({ name: user.name, netid: user.netid })
		.from(userRoles)
		.innerJoin(user, eq(userRoles.userId, user.id))
		.where(eq(userRoles.roleId, OFFICER_ROLE_ID))
		.limit(limit);
	return officers.map((o) => ({ cells: [o.netid ?? "—", o.name] }));
}

function provisioningNote(
	status: string | undefined,
): PersonalMetrics["provisioning"] {
	if (status === "provisioned") {
		return { note: "Account provisioned", tone: "success" };
	}
	if (status === "failed") {
		return {
			note: "Provisioning failed — contact an officer",
			tone: "error",
		};
	}
	return { note: "Provisioning pending", tone: "warning" };
}

export function personalMetricsFromProfile(profile: {
	status?: string;
	adProvisioningStatus?: string;
	answers?: unknown;
} | null): PersonalMetrics {
	const answers = (profile?.answers ?? {}) as Record<string, unknown>;
	const sigInterest = Array.isArray(answers.sig_interest)
		? answers.sig_interest.length
		: 0;
	const gradRaw = answers.grad_year;
	const gradYear =
		typeof gradRaw === "number"
			? gradRaw
			: typeof gradRaw === "string" && /^\d{4}$/.test(gradRaw)
				? Number(gradRaw)
				: null;

	return {
		membership: profile?.status === "active" ? "Active" : "Inactive",
		provisioning: provisioningNote(profile?.adProvisioningStatus),
		sigCount: sigInterest,
		gradYear,
	};
}

export async function loadUserRoleKeys(userId: string): Promise<string[]> {
	const rows = await db
		.select({ key: roles.key })
		.from(userRoles)
		.innerJoin(roles, eq(userRoles.roleId, roles.id))
		.where(eq(userRoles.userId, userId));
	return rows.map((r) => r.key);
}

export async function loadGrowthBars(): Promise<number[]> {
	const rosterDates = await db
		.select({ createdAt: memberProfiles.createdAt })
		.from(memberProfiles)
		.where(
			gte(
				memberProfiles.createdAt,
				new Date(Date.now() - CHART_WEEKS * 7 * 86_400_000),
			),
		);

	const bars = new Array<number>(CHART_WEEKS).fill(0);
	const now = Date.now();
	for (const row of rosterDates) {
		const weekIndex = Math.floor(
			(now - new Date(row.createdAt).getTime()) / (7 * 86_400_000),
		);
		if (weekIndex >= 0 && weekIndex < CHART_WEEKS)
			bars[CHART_WEEKS - 1 - weekIndex]++;
	}
	return bars;
}

function staffShortcuts(perms: Set<PermissionKey>): StaffShortcut[] {
	const links: StaffShortcut[] = [];
	if (perms.has("signups.review")) {
		links.push({ href: "/dashboard/admin/signups", label: "Review signups" });
	}
	if (perms.has("members.read")) {
		links.push({ href: "/dashboard/admin/members", label: "Manage members" });
	}
	if (perms.has("content.publish") || perms.has("content.manage")) {
		links.push({ href: "/dashboard/admin/content", label: "Publish content" });
	}
	if (perms.has("alumni.review")) {
		links.push({
			href: "/dashboard/admin/alumni",
			label: "Alumni candidates",
		});
	}
	if (perms.has("forms.read")) {
		links.push({ href: "/dashboard/admin/forms", label: "Signup forms" });
	}
	if (perms.has("roles.read")) {
		links.push({ href: "/dashboard/admin/roles", label: "Roles matrix" });
	}
	return links;
}

export async function loadStaffDashboard(perms: Set<PermissionKey>) {
	const canReviewSignups = perms.has("signups.review");
	const canReviewAlumni = perms.has("alumni.review");

	const [activeCountRow, pendingSignupRow, announcements, bars, alumni] =
		await Promise.all([
			db
				.select({ value: count() })
				.from(memberProfiles)
				.where(eq(memberProfiles.status, "active")),
			canReviewSignups
				? db
						.select({ value: count() })
						.from(signupSubmissions)
						.where(eq(signupSubmissions.status, "pending"))
				: Promise.resolve([{ value: 0 }]),
			loadAnnouncements(),
			loadGrowthBars(),
			canReviewAlumni ? computeAlumniCandidates() : Promise.resolve([]),
		]);

	const pendingSignups = canReviewSignups
		? await db
				.select({
					id: signupSubmissions.id,
					name: sql<string>`trim(concat(${signupSubmissions.firstName}, ' ', ${signupSubmissions.lastName}))`,
					netid: signupSubmissions.netid,
					createdAt: signupSubmissions.createdAt,
				})
				.from(signupSubmissions)
				.where(eq(signupSubmissions.status, "pending"))
				.orderBy(desc(signupSubmissions.createdAt))
				.limit(5)
		: [];

	return {
		metrics: {
			activeMembers: Number(activeCountRow[0]?.value ?? 0),
			pendingSignups: canReviewSignups
				? Number(pendingSignupRow[0]?.value ?? 0)
				: null,
			alumniCandidates: canReviewAlumni ? alumni.length : null,
		},
		pendingSignups: pendingSignups.map((s) => ({
			cells: [s.netid, s.name, s.createdAt.toLocaleDateString("en-US")],
		})),
		alumniCandidates: alumni.slice(0, 5).map((a) => ({
			cells: [a.netid ?? "—", a.name, String(a.gradYear)],
		})),
		announcements,
		bars,
		shortcuts: staffShortcuts(perms),
		canReviewSignups,
		canReviewAlumni,
	};
}

export async function loadSigLeaderDashboard(userId: string) {
	const led = await db
		.select({
			sigId: sigs.id,
			sigKey: sigs.key,
			displayName: sigs.displayName,
		})
		.from(sigLeaders)
		.innerJoin(sigs, eq(sigLeaders.sigId, sigs.id))
		.where(and(eq(sigLeaders.userId, userId), eq(sigs.active, true)));

	const announcements = await loadAnnouncements();

	if (led.length === 0) {
		return { ledSigs: [] as SigInterestGroup[], announcements };
	}

	const keys = led.map((s) => s.sigKey);
	const interested = await db.execute<{
		sigKey: string;
		name: string;
		netid: string | null;
		gradYear: string | null;
		[key: string]: unknown;
	}>(sql`
		SELECT s.key AS "sigKey", u.name, u.netid,
		       mp.answers->>'grad_year' AS "gradYear"
		FROM sigs s
		JOIN member_profiles mp
		  ON mp.status = 'active'
		 AND mp.answers->'sig_interest' ? s.key
		JOIN "user" u ON u.id = mp.user_id
		WHERE s.key IN (${sql.join(
			keys.map((k) => sql`${k}`),
			sql`, `,
		)})
		ORDER BY s.key ASC, u.name ASC
	`);

	const byKey = new Map<string, TableRow[]>();
	for (const row of interested.rows) {
		const list = byKey.get(String(row.sigKey)) ?? [];
		list.push({
			cells: [
				String(row.netid ?? "—"),
				String(row.name),
				row.gradYear ? String(row.gradYear) : "—",
			],
		});
		byKey.set(String(row.sigKey), list);
	}

	const ledSigs: SigInterestGroup[] = led.map((s) => {
		const members = byKey.get(s.sigKey) ?? [];
		return {
			sigId: s.sigId,
			sigKey: s.sigKey,
			displayName: s.displayName,
			interestCount: members.length,
			members,
		};
	});

	return { ledSigs, announcements };
}

export async function loadMemberLikeDashboard(userId: string) {
	const [[profile], officers, announcements] = await Promise.all([
		db
			.select({
				status: memberProfiles.status,
				adProvisioningStatus: memberProfiles.adProvisioningStatus,
				answers: memberProfiles.answers,
			})
			.from(memberProfiles)
			.where(eq(memberProfiles.userId, userId))
			.limit(1),
		loadOfficers(),
		loadAnnouncements(),
	]);

	return {
		metrics: personalMetricsFromProfile(profile ?? null),
		officers,
		announcements,
	};
}

export async function loadActiveSigs() {
	return db
		.select({
			id: sigs.id,
			key: sigs.key,
			displayName: sigs.displayName,
		})
		.from(sigs)
		.where(eq(sigs.active, true))
		.orderBy(sigs.displayName);
}

export async function loadSigLeadersByUser() {
	const rows = await db
		.select({
			userId: sigLeaders.userId,
			sigId: sigLeaders.sigId,
		})
		.from(sigLeaders);
	const map = new Map<string, string[]>();
	for (const row of rows) {
		const list = map.get(row.userId) ?? [];
		list.push(row.sigId);
		map.set(row.userId, list);
	}
	return map;
}

type DbLike = {
	select: typeof db.select;
	insert: typeof db.insert;
	delete: typeof db.delete;
};

/** Sync sig_leaders for a user. Empty list clears all. */
export async function replaceSigLeaders(
	tx: DbLike,
	opts: {
		userId: string;
		sigIds: string[];
		actorId: string;
		validSigIds: Set<string>;
	},
) {
	const desired = [...new Set(opts.sigIds)].filter((id) =>
		opts.validSigIds.has(id),
	);
	const existing = await tx
		.select({ sigId: sigLeaders.sigId })
		.from(sigLeaders)
		.where(eq(sigLeaders.userId, opts.userId));
	const existingIds = new Set(existing.map((e) => e.sigId));
	const desiredSet = new Set(desired);

	const toRemove = [...existingIds].filter((id) => !desiredSet.has(id));
	const toAdd = desired.filter((id) => !existingIds.has(id));

	if (toRemove.length) {
		await tx
			.delete(sigLeaders)
			.where(
				and(
					eq(sigLeaders.userId, opts.userId),
					inArray(sigLeaders.sigId, toRemove),
				),
			);
	}
	for (const sigId of toAdd) {
		await tx.insert(sigLeaders).values({
			userId: opts.userId,
			sigId,
			assignedBy: opts.actorId,
		});
	}

	return { added: toAdd, removed: toRemove };
}

export type DashboardPayload = {
	view: DashboardView;
	canPreview: boolean;
	isPreview: boolean;
	displayName: string;
	staff: Awaited<ReturnType<typeof loadStaffDashboard>> | null;
	sigLeader: Awaited<ReturnType<typeof loadSigLeaderDashboard>> | null;
	member: Awaited<ReturnType<typeof loadMemberLikeDashboard>> | null;
};
