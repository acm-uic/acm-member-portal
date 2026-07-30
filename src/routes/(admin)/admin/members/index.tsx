import { component$ } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, asc, eq } from "drizzle-orm";
import { db } from "~/lib/db";
import {
	auditEvents,
	memberProfiles,
	roles,
	user,
	userRoles,
} from "~/lib/db/schema";
import { getPermissions, requirePermission } from "~/lib/rbac/guards";

export const useMembers = routeLoader$(async (event) => {
	await requirePermission(event, "members.read");
	const perms = await getPermissions(event);
	const restricted = perms.has("members.read.restricted");

	const [members, allRoles, memberships] = await Promise.all([
		db
			.select({
				id: user.id,
				name: user.name,
				netid: user.netid,
				status: memberProfiles.status,
				adProvisioningStatus: memberProfiles.adProvisioningStatus,
				...(restricted ? { uin: user.uin } : {}),
			})
			.from(user)
			.innerJoin(memberProfiles, eq(memberProfiles.userId, user.id))
			.orderBy(asc(user.name))
			.limit(50),
		db.select().from(roles).orderBy(asc(roles.key)),
		db.select().from(userRoles),
	]);

	const rolesByUser = new Map<string, string[]>();
	for (const m of memberships) {
		const list = rolesByUser.get(m.userId) ?? [];
		const role = allRoles.find((r) => r.id === m.roleId);
		if (role) list.push(role.key);
		rolesByUser.set(m.userId, list);
	}

	return {
		members: members.map((m) => ({
			...m,
			uin: "uin" in m ? m.uin : null,
			roles: rolesByUser.get(m.id) ?? [],
		})),
		roles: allRoles.map((r) => ({
			id: r.id,
			key: r.key,
			displayName: r.displayName,
		})),
	};
});

export const useAssignRole = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "members.manage");
	const targetUserId = String(data.userId ?? "");
	const roleId = String(data.roleId ?? "");
	const assign = data.assign === "true";

	await db.transaction(async (tx) => {
		if (assign) {
			await tx
				.insert(userRoles)
				.values({ userId: targetUserId, roleId, assignedBy: session.user.id })
				.onConflictDoNothing();
		} else {
			await tx
				.delete(userRoles)
				.where(
					and(eq(userRoles.userId, targetUserId), eq(userRoles.roleId, roleId)),
				);
		}
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: assign ? "members.role.assign" : "members.role.remove",
			targetType: "user",
			targetId: targetUserId,
			after: { roleId },
		});
	});

	return { ok: true as const };
});

export const useSetMemberStatus = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "members.deactivate");
	const targetUserId = String(data.userId ?? "");
	const deactivate = data.deactivate === "true";

	await db.transaction(async (tx) => {
		await tx
			.update(memberProfiles)
			.set(
				deactivate
					? {
							status: "deactivated",
							deactivatedAt: new Date(),
							deactivatedBy: session.user.id,
						}
					: { status: "active", deactivatedAt: null, deactivatedBy: null },
			)
			.where(eq(memberProfiles.userId, targetUserId));
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: deactivate ? "members.deactivate" : "members.reactivate",
			targetType: "user",
			targetId: targetUserId,
		});
	});

	return { ok: true as const };
});

export default component$(() => {
	const data = useMembers();
	const assignRole = useAssignRole();
	const setStatus = useSetMemberStatus();

	return (
		<main class="p-xl grid gap-lg max-w-5xl">
			<header>
				<h1 class="font-display text-heading m-0">Members</h1>
				<p class="text-text2 text-body m-0">
					{data.value.members.length} accounts
				</p>
			</header>

			<table class="w-full border-collapse text-body-sm">
				<thead>
					<tr class="text-left text-text3 text-caption">
						<th class="py-sm border-t border-border">Name</th>
						<th class="py-sm border-t border-border">NetID</th>
						<th class="py-sm border-t border-border">UIN</th>
						<th class="py-sm border-t border-border">Roles</th>
						<th class="py-sm border-t border-border">Status</th>
						<th class="py-sm border-t border-border">Actions</th>
					</tr>
				</thead>
				<tbody>
					{data.value.members.map((m) => (
						<tr key={m.id}>
							<td class="py-sm border-t border-border text-text1">{m.name}</td>
							<td class="py-sm border-t border-border font-mono text-text3">
								{m.netid ?? "—"}
							</td>
							<td class="py-sm border-t border-border font-mono text-text3">
								{m.uin ?? "—"}
							</td>
							<td class="py-sm border-t border-border">
								<div class="flex gap-2xs flex-wrap">
									{data.value.roles.map((role) => {
										const has = m.roles.includes(role.key);
										return (
											<button
												key={role.id}
												type="button"
												title={`${has ? "Remove" : "Assign"} ${role.displayName}`}
												class={`px-sm py-2xs rounded-element text-caption cursor-pointer border ${
													has
														? "bg-accent-subtle text-text1 border-accent"
														: "text-text4 border-border"
												}`}
												onClick$={async () => {
													await assignRole.submit({
														userId: m.id,
														roleId: role.id,
														assign: String(!has),
													});
												}}
											>
												{role.displayName}
											</button>
										);
									})}
								</div>
							</td>
							<td class="py-sm border-t border-border">
								<span
									class={`px-sm py-2xs rounded-element text-caption font-semibold ${
										m.status === "active"
											? "bg-success-bg text-success"
											: "bg-error-bg text-error"
									}`}
								>
									{m.status}
								</span>
							</td>
							<td class="py-sm border-t border-border">
								<button
									type="button"
									class={`px-sm py-2xs rounded-control text-label cursor-pointer border ${
										m.status === "active"
											? "border-error text-error"
											: "border-border-visible text-text1"
									}`}
									onClick$={async () => {
										await setStatus.submit({
											userId: m.id,
											deactivate: String(m.status === "active"),
										});
									}}
								>
									{m.status === "active" ? "Deactivate" : "Reactivate"}
								</button>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</main>
	);
});
