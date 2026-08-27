import {
	$,
	component$,
	useOnWindow,
	useSignal,
} from "@builder.io/qwik";
import { Link, routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, asc, eq } from "drizzle-orm";
import { AlertModal } from "~/components/admin/alert-modal";
import {
	loadActiveSigs,
	loadSigLeadersByUser,
	replaceSigLeaders,
} from "~/lib/dashboard/load";
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

const SIG_LEADER_ROLE_KEY = "sig_leader";

export const useMembers = routeLoader$(async (event) => {
	const session = await requirePermission(event, "members.read");
	const perms = await getPermissions(event);
	const restricted = perms.has("members.read.restricted");
	const canManage = perms.has("members.manage");

	const [members, allRoles, memberships, actorMemberships, allSigs, leaders] =
		await Promise.all([
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
			loadActiveSigs(),
			loadSigLeadersByUser(),
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
			ledSigIds: leaders.get(m.id) ?? [],
		})),
		roles: allRoles.map((r) => ({
			id: r.id,
			key: r.key,
			displayName: r.displayName,
		})),
		sigs: allSigs,
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
type SigLeaderChange = { userId: string; sigIds: string[] };

export const useSaveRoleChanges = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "members.manage");
	const perms = await getPermissions(event);

	let changes: RoleChange[] = [];
	let sigChanges: SigLeaderChange[] = [];
	try {
		changes = JSON.parse(String(data.changes ?? "[]")) as RoleChange[];
		sigChanges = JSON.parse(
			String(data.sigChanges ?? "[]"),
		) as SigLeaderChange[];
	} catch {
		return { ok: false as const, error: "Those role changes could not be read." };
	}
	if (
		(!Array.isArray(changes) || changes.length === 0) &&
		(!Array.isArray(sigChanges) || sigChanges.length === 0)
	) {
		return { ok: true as const, applied: 0 };
	}

	const [allRoles, memberships, allSigs] = await Promise.all([
		db.select().from(roles),
		db.select().from(userRoles),
		loadActiveSigs(),
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
	const validSigIds = new Set(allSigs.map((s) => s.id));
	const sigLeaderRole = allRoles.find((r) => r.key === SIG_LEADER_ROLE_KEY);

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

	if (blocked.length && accepted.length === 0 && sigChanges.length === 0) {
		return { ok: false as const, error: blocked.join(" ") };
	}

	// Simulate resulting role keys after accepted changes for SIG assignment rules.
	const projectedRoles = new Map(rolesByUser);
	for (const change of accepted) {
		const role = roleById.get(change.roleId);
		if (!role) continue;
		const list = [...(projectedRoles.get(change.userId) ?? [])];
		if (change.assign) {
			if (!list.includes(role.key)) list.push(role.key);
		} else {
			const idx = list.indexOf(role.key);
			if (idx >= 0) list.splice(idx, 1);
		}
		projectedRoles.set(change.userId, list);
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

			// Removing sig_leader clears all SIG leadership.
			if (
				!change.assign &&
				sigLeaderRole &&
				change.roleId === sigLeaderRole.id
			) {
				const { removed } = await replaceSigLeaders(tx, {
					userId: change.userId,
					sigIds: [],
					actorId: session.user.id,
					validSigIds,
				});
				for (const sigId of removed) {
					await tx.insert(auditEvents).values({
						actorId: session.user.id,
						action: "members.sig_leader.remove",
						targetType: "user",
						targetId: change.userId,
						after: { sigId },
					});
				}
			}
		}

		for (const sigChange of sigChanges) {
			const hasSigLeader = (
				projectedRoles.get(sigChange.userId) ?? []
			).includes(SIG_LEADER_ROLE_KEY);
			const desired = hasSigLeader ? sigChange.sigIds : [];
			const { added, removed } = await replaceSigLeaders(tx, {
				userId: sigChange.userId,
				sigIds: desired,
				actorId: session.user.id,
				validSigIds,
			});
			for (const sigId of added) {
				await tx.insert(auditEvents).values({
					actorId: session.user.id,
					action: "members.sig_leader.assign",
					targetType: "user",
					targetId: sigChange.userId,
					after: { sigId },
				});
			}
			for (const sigId of removed) {
				await tx.insert(auditEvents).values({
					actorId: session.user.id,
					action: "members.sig_leader.remove",
					targetType: "user",
					targetId: sigChange.userId,
					after: { sigId },
				});
			}
		}
	});

	if (blocked.length) {
		return {
			ok: false as const,
			error: `Saved some role changes. Skipped: ${blocked.join(" ")}`,
		};
	}
	return {
		ok: true as const,
		applied: accepted.length + sigChanges.length,
	};
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
	const pendingSigs = useSignal<Record<string, string[]>>({});
	const modal = useSignal<string | null>(null);

	const desiredRoles = (userId: string, original: string[]) =>
		pending.value[userId] ?? original;

	const desiredSigs = (userId: string, original: string[]) =>
		pendingSigs.value[userId] ?? original;

	const hasUnsaved = () => {
		const rolesDirty = Object.entries(pending.value).some(([userId, keys]) => {
			const member = data.value.members.find((m) => m.id === userId);
			if (!member) return false;
			return [...keys].sort().join(",") !== [...member.roles].sort().join(",");
		});
		const sigsDirty = Object.entries(pendingSigs.value).some(
			([userId, keys]) => {
				const member = data.value.members.find((m) => m.id === userId);
				if (!member) return false;
				return (
					[...keys].sort().join(",") !== [...member.ledSigIds].sort().join(",")
				);
			},
		);
		return rolesDirty || sigsDirty;
	};

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

			// Clearing sig_leader clears pending SIG picks.
			if (!assign && roleKey === SIG_LEADER_ROLE_KEY) {
				const member = data.value.members.find((m) => m.id === userId);
				const sigCopy = { ...pendingSigs.value };
				if (member && member.ledSigIds.length === 0) delete sigCopy[userId];
				else sigCopy[userId] = [];
				pendingSigs.value = sigCopy;
			}
		},
	);

	const tryToggleSig = $((userId: string, original: string[], sigId: string) => {
		const currentDesired = pendingSigs.value[userId] ?? original;
		const assign = !currentDesired.includes(sigId);
		const next = assign
			? [...currentDesired, sigId]
			: currentDesired.filter((id) => id !== sigId);
		const origSorted = [...original].sort().join(",");
		const nextSorted = [...next].sort().join(",");
		const copy = { ...pendingSigs.value };
		if (nextSorted === origSorted) delete copy[userId];
		else copy[userId] = next;
		pendingSigs.value = copy;
	});

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

		const sigChanges: SigLeaderChange[] = [];
		for (const member of data.value.members) {
			const desiredRolesForUser = desiredRoles(member.id, member.roles);
			const wantsLeader = desiredRolesForUser.includes(SIG_LEADER_ROLE_KEY);
			const desired = wantsLeader
				? desiredSigs(member.id, member.ledSigIds)
				: [];
			const origSorted = [...member.ledSigIds].sort().join(",");
			const nextSorted = [...desired].sort().join(",");
			if (origSorted !== nextSorted) {
				sigChanges.push({ userId: member.id, sigIds: desired });
			}
		}

		if (changes.length === 0 && sigChanges.length === 0) return;
		const result = await saveRoles.submit({
			changes: JSON.stringify(changes),
			sigChanges: JSON.stringify(sigChanges),
		});
		if (result.value?.ok) {
			pending.value = {};
			pendingSigs.value = {};
		} else if (result.value && "error" in result.value) {
			modal.value = result.value.error ?? "Those role changes could not be saved.";
		}
	});

	useOnWindow(
		"beforeunload",
		$((event) => {
			if (!hasUnsaved()) return;
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
						until you save. Assign SIGs when Sig Leader is selected.
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
						<th class="py-sm border-t border-border">SIG leadership</th>
						<th class="py-sm border-t border-border">Status</th>
						<th class="py-sm border-t border-border">Actions</th>
					</tr>
				</thead>
				<tbody>
					{data.value.members.map((m) => {
						const rolesDesired = desiredRoles(m.id, m.roles);
						const showSigs = rolesDesired.includes(SIG_LEADER_ROLE_KEY);
						return (
							<tr key={m.id}>
								<td class="py-sm border-t border-border text-text1">
									{m.name}
								</td>
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
											const desired = rolesDesired.includes(role.key);
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
									{showSigs ? (
										<div class="flex gap-2xs flex-wrap max-w-[220px]">
											{data.value.sigs.map((sig) => {
												const original = m.ledSigIds.includes(sig.id);
												const desired = desiredSigs(m.id, m.ledSigIds).includes(
													sig.id,
												);
												const pendingChange = desired !== original;
												const className = pendingChange
													? "bg-warning-bg text-warning border-warning"
													: desired
														? "bg-accent-subtle text-text1 border-accent"
														: "text-text4 border-border";
												return (
													<button
														key={sig.id}
														type="button"
														title={`${desired ? "Remove" : "Assign"} ${sig.displayName}${pendingChange ? " (unsaved)" : ""}`}
														class={`px-sm py-2xs rounded-element text-caption cursor-pointer border ${className}`}
														onClick$={async () => {
															await tryToggleSig(m.id, m.ledSigIds, sig.id);
														}}
													>
														{sig.displayName}
													</button>
												);
											})}
										</div>
									) : (
										<span class="text-text4 text-caption">—</span>
									)}
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
						);
					})}
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
