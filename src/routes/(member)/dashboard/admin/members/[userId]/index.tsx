import { component$ } from "@builder.io/qwik";
import { Link, routeLoader$ } from "@builder.io/qwik-city";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "~/lib/db";
import { auditEvents, user } from "~/lib/db/schema";
import { requirePermission } from "~/lib/rbac/guards";

const FIELD_LABELS: Record<string, string> = {
	first_name: "First name",
	last_name: "Last name",
	preferred_name: "Preferred name",
	netid: "NetID",
	username: "Username",
	uin: "UIN",
	email: "Email",
};

function formatValue(value: unknown): string {
	if (value == null || value === "") return "—";
	if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function actionLabel(action: string): string {
	switch (action) {
		case "profile.update":
			return "Updated profile";
		case "members.role.assign":
			return "Assigned a role";
		case "members.role.remove":
			return "Removed a role";
		case "members.deactivate":
			return "Deactivated";
		case "members.reactivate":
			return "Reactivated";
		default:
			return action;
	}
}

export const useMemberHistory = routeLoader$(async (event) => {
	await requirePermission(event, "members.read");
	const userId = event.params.userId ?? "";

	const [row] = await db
		.select({
			id: user.id,
			name: user.name,
			email: user.email,
			netid: user.netid,
			username: user.username,
		})
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	if (!row) throw event.error(404, "Member not found");

	const rows = await db
		.select({
			id: auditEvents.id,
			action: auditEvents.action,
			before: auditEvents.before,
			after: auditEvents.after,
			createdAt: auditEvents.createdAt,
			actorId: auditEvents.actorId,
		})
		.from(auditEvents)
		.where(eq(auditEvents.targetId, userId))
		.orderBy(desc(auditEvents.createdAt))
		.limit(200);

	const actorIds = [
		...new Set(rows.map((e) => e.actorId).filter((id): id is string => !!id)),
	];
	const actors = actorIds.length
		? await db
				.select({ id: user.id, name: user.name })
				.from(user)
				.where(inArray(user.id, actorIds))
		: [];
	const actorName = new Map(actors.map((a) => [a.id, a.name]));

	return {
		member: row,
		events: rows.map((e) => {
			const after = (e.after ?? {}) as Record<string, unknown>;
			const stored = after.changes as
				| { field: string; oldValue: unknown; newValue: unknown }[]
				| undefined;
			const before = (e.before ?? {}) as Record<string, unknown>;
			const changes =
				stored ??
				Object.keys({ ...before, ...after })
					.filter((k) => k !== "changes")
					.filter(
						(k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
					)
					.map((field) => ({
						field,
						oldValue: before[field],
						newValue: after[field],
					}));
			return {
				id: e.id,
				action: e.action,
				createdAt: e.createdAt,
				actorName: e.actorId ? actorName.get(e.actorId) : undefined,
				changes,
			};
		}),
	};
});

export default component$(() => {
	const data = useMemberHistory();

	return (
		<main class="p-xl grid gap-lg max-w-3xl">
			<p class="m-0">
				<Link
					href="/dashboard/admin/members"
					class="text-accent text-label no-underline"
				>
					← Members
				</Link>
			</p>
			<header>
				<h1 class="font-display text-heading m-0">Change history</h1>
				<p class="text-text2 text-body m-0">
					{data.value.member.name}
					{data.value.member.username
						? ` (${data.value.member.username})`
						: ""}
				</p>
			</header>

			{data.value.events.length === 0 ? (
				<p class="text-text3 text-body">No recorded changes for this member.</p>
			) : (
				<ol class="grid gap-md m-0 p-0 list-none">
					{data.value.events.map((event) => (
						<li
							key={event.id}
							class="bg-surface1 border border-border rounded-component p-md grid gap-sm"
						>
							<div class="flex justify-between gap-md flex-wrap">
								<strong class="text-label text-text1">
									{actionLabel(event.action)}
								</strong>
								<span class="text-caption text-text3">
									{new Date(event.createdAt).toLocaleString()}
								</span>
							</div>
							<p class="text-caption text-text3 m-0">
								By {event.actorName ?? "unknown"}
							</p>
							{event.changes.length > 0 && (
								<table class="w-full text-body-sm border-collapse">
									<thead>
										<tr class="text-left text-text3 text-caption">
											<th class="py-2xs pr-sm">Field</th>
											<th class="py-2xs pr-sm">From</th>
											<th class="py-2xs">To</th>
										</tr>
									</thead>
									<tbody>
										{event.changes.map((c) => (
											<tr key={c.field}>
												<td class="py-2xs pr-sm text-text1">
													{FIELD_LABELS[c.field] ?? c.field}
												</td>
												<td class="py-2xs pr-sm font-mono text-text3">
													{formatValue(c.oldValue)}
												</td>
												<td class="py-2xs font-mono text-text1">
													{formatValue(c.newValue)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							)}
						</li>
					))}
				</ol>
			)}
		</main>
	);
});
