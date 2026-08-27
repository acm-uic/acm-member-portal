import {
	$,
	component$,
	useOnWindow,
	useSignal,
} from "@builder.io/qwik";
import { Link, routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, asc, eq } from "drizzle-orm";
import { AlertModal } from "~/components/admin/alert-modal";
import { db } from "~/lib/db";
import {
	auditEvents,
	memberProfiles,
	roles,
	user,
	userRoles,
} from "~/lib/db/schema";
import { getPermissions, requirePermission } from "~/lib/rbac/guards";
import { roleChangeBlocked } from "~/lib/rbac/role-assign";

export const useMembers = routeLoader$(async (event) => {
	const session = await requirePermission(event, "members.read");
	const perms = await getPermissions(event);
	const restricted = perms.has("members.read.restricted");
	const canManage = perms.has("members.manage");

	const [members, allRoles, memberships, actorMemberships] = await Promise.all([
		db
			.select({
				id: user.id,
				name: user.name,
				netid: user.netid,
				username: user.username,
				status: memberProfiles.status,
				adProvisioningStatus: memberProfiles.adProvisioningStatus,
				uin: user.uin,
			})
			.from(user)
			.innerJoin(memberProfiles, eq(memberProfiles.userId, user.id))
			.orderBy(asc(user.name))
			.limit(50),
		db.select().from(roles).orderBy(asc(roles.key)),
		db.select().from(userRoles),
		db
			.select({ roleId: userRoles.roleId })
			.from(userRoles)
			.where(eq(userRoles.userId, session.user.id)),
	]);

	const rolesByUser = new Map<string, string[]>();
	const adminUserIds: string[] = [];
	for (const m of memberships) {
		const list = rolesByUser.get(m.userId) ?? [];
		const role = allRoles.find((r) => r.id === m.roleId);
		if (role) {
			list.push(role.key);
			if (role.key === "admin") adminUserIds.push(m.userId);
		}
		rolesByUser.set(m.userId, list);
	}

	const actorRoleKeys = actorMemberships
		.map((m) => allRoles.find((r) => r.id === m.roleId)?.key)
		.filter((k): k is string => Boolean(k));

	return {
		members: members.map((m) => ({
			...m,
			uin: restricted ? m.uin : null,
			roles: rolesByUser.get(m.id) ?? [],
		})),
		roles: allRoles.map((r) => ({
			id: r.id,
			key: r.key,
			displayName: r.displayName,
		})),
		actor: {
			userId: session.user.id,
			roleKeys: actorRoleKeys,
			permissions: [...perms],
			canManage,
		},
		adminUserIds,
	};
});

type RoleChange = { userId: string; roleId: string; assign: boolean };

export const useSaveRoleChanges = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "members.manage");
	const perms = await getPermissions(event);

	let changes: RoleChange[] = [];
	try {
		changes = JSON.parse(String(data.changes ?? "[]")) as RoleChange[];
	} catch {
		return { ok: false as const, error: "Those role changes could not be read." };
	}
	if (!Array.isArray(changes) || changes.length === 0) {
		return { ok: true as const, applied: 0 };
	}

	const [allRoles, memberships] = await Promise.all([
		db.select().from(roles),
		db.select().from(userRoles),
	]);
	const roleById = new Map(allRoles.map((r) => [r.id, r]));
	const rolesByUser = new Map<string, string[]>();
	const adminUserIds: string[] = [];
	for (const m of memberships) {
		const role = roleById.get(m.roleId);
		if (!role) continue;
		const list = rolesByUser.get(m.userId) ?? [];
		list.push(role.key);
		rolesByUser.set(m.userId, list);
		if (role.key === "admin") adminUserIds.push(m.userId);
	}

	const actorRoleKeys = rolesByUser.get(session.user.id) ?? [];

	const blocked: string[] = [];
	const accepted: RoleChange[] = [];
	for (const change of changes) {
		const role = roleById.get(change.roleId);
		if (!role) {
			blocked.push("Unknown role.");
			continue;
		}
		const reason = roleChangeBlocked({
			actorUserId: session.user.id,
			actorRoleKeys,
			actorPermissions: perms,
			targetUserId: change.userId,
			targetRoleKeys: rolesByUser.get(change.userId) ?? [],
			adminUserIds,
			roleKey: role.key,
			assign: change.assign,
		});
		if (reason) blocked.push(`${role.displayName}: ${reason}`);
		else accepted.push(change);
	}

	if (blocked.length && accepted.length === 0) {
		return { ok: false as const, error: blocked.join(" ") };
	}

	await db.transaction(async (tx) => {
		for (const change of accepted) {
			if (change.assign) {
				await tx
					.insert(userRoles)
					.values({
						userId: change.userId,
						roleId: change.roleId,
						assignedBy: session.user.id,
					})
					.onConflictDoNothing();
			} else {
				await tx
					.delete(userRoles)
					.where(
						and(
							eq(userRoles.userId, change.userId),
							eq(userRoles.roleId, change.roleId),
						),
					);
			}
			await tx.insert(auditEvents).values({
				actorId: session.user.id,
				action: change.assign ? "members.role.assign" : "members.role.remove",
				targetType: "user",
				targetId: change.userId,
				after: { roleId: change.roleId },
			});
		}
	});

	if (blocked.length) {
		return {
			ok: false as const,
			error: `Saved some role changes. Skipped: ${blocked.join(" ")}`,
		};
	}
	return { ok: true as const, applied: accepted.length };
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
	const saveRoles = useSaveRoleChanges();
	const setStatus = useSetMemberStatus();
	const pending = useSignal<Record<string, string[]>>({});
	const modal = useSignal<string | null>(null);

	const desiredRoles = (userId: string, original: string[]) =>
		pending.value[userId] ?? original;

	const hasUnsaved = () =>
		Object.entries(pending.value).some(([userId, keys]) => {
			const member = data.value.members.find((m) => m.id === userId);
			if (!member) return false;
			const orig = [...member.roles].sort().join(",");
			return [...keys].sort().join(",") !== orig;
		});

	const tryToggle = $(
		(userId: string, original: string[], roleKey: string) => {
			const actor = data.value.actor;
			const currentDesired = pending.value[userId] ?? original;
			const assign = !currentDesired.includes(roleKey);
			const reason = roleChangeBlocked({
				actorUserId: actor.userId,
				actorRoleKeys: actor.roleKeys,
				actorPermissions: actor.permissions,
				targetUserId: userId,
				targetRoleKeys: original,
				adminUserIds: data.value.adminUserIds,
				roleKey,
				assign,
			});
			if (reason) {
				modal.value = reason;
				return;
			}
			const next = assign
				? [...currentDesired, roleKey]
				: currentDesired.filter((k) => k !== roleKey);
			const origSorted = [...original].sort().join(",");
			const nextSorted = [...next].sort().join(",");
			const copy = { ...pending.value };
			if (nextSorted === origSorted) delete copy[userId];
			else copy[userId] = next;
			pending.value = copy;
		},
	);

	const savePending = $(async () => {
		const changes: RoleChange[] = [];
		for (const member of data.value.members) {
			const desired = pending.value[member.id];
			if (!desired) continue;
			for (const role of data.value.roles) {
				const had = member.roles.includes(role.key);
				const wants = desired.includes(role.key);
				if (had !== wants) {
					changes.push({
						userId: member.id,
						roleId: role.id,
						assign: wants,
					});
				}
			}
		}
		if (changes.length === 0) return;
		const result = await saveRoles.submit({ changes: JSON.stringify(changes) });
		if (result.value?.ok) {
			pending.value = {};
		} else if (result.value && "error" in result.value) {
			modal.value = result.value.error ?? "Those role changes could not be saved.";
		}
	});

	useOnWindow(
		"beforeunload",
		$((event) => {
			const dirty = Object.entries(pending.value).some(([userId, keys]) => {
				const member = data.value.members.find((m) => m.id === userId);
				if (!member) return false;
				return [...keys].sort().join(",") !== [...member.roles].sort().join(",");
			});
			if (!dirty) return;
			event.preventDefault();
			(event as BeforeUnloadEvent).returnValue = "";
		}),
	);

	return (
		<main class="p-xl grid gap-lg max-w-5xl">
			<header class="flex items-start justify-between gap-md flex-wrap">
				<div>
					<h1 class="font-display text-heading m-0">Members</h1>
					<p class="text-text2 text-body m-0">
						{data.value.members.length} accounts. Role toggles stay highlighted
						until you save.
					</p>
				</div>
				<button
					type="button"
					disabled={!hasUnsaved()}
					class={`px-md py-sm rounded-control text-label border ${
						hasUnsaved()
							? "bg-accent text-white border-accent cursor-pointer"
							: "bg-surface2 text-text3 border-border cursor-not-allowed"
					}`}
					onClick$={savePending}
				>
					Save changes
				</button>
			</header>

			{saveRoles.value?.ok && (
				<p class="text-success text-label m-0">Role changes saved.</p>
			)}

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
										const original = m.roles.includes(role.key);
										const desired = desiredRoles(m.id, m.roles).includes(
											role.key,
										);
										const pendingChange = desired !== original;
										const className = pendingChange
											? "bg-warning-bg text-warning border-warning"
											: desired
												? "bg-accent-subtle text-text1 border-accent"
												: "text-text4 border-border";
										return (
											<button
												key={role.id}
												type="button"
												title={`${desired ? "Remove" : "Assign"} ${role.displayName}${pendingChange ? " (unsaved)" : ""}`}
												class={`px-sm py-2xs rounded-element text-caption cursor-pointer border ${className}`}
												onClick$={async () => {
													await tryToggle(m.id, m.roles, role.key);
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
								<div class="flex gap-sm items-center flex-wrap">
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
									<Link
										href={`/dashboard/admin/members/${m.id}`}
										class="text-accent text-label no-underline"
									>
										History
									</Link>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			{modal.value && (
				<AlertModal
					title="Can't change that role"
					message={modal.value}
					onClose$={$(() => {
						modal.value = null;
					})}
				/>
			)}
		</main>
	);
});
