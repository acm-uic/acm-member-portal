import { component$ } from "@builder.io/qwik";
import { routeAction$, routeLoader$ } from "@builder.io/qwik-city";
import { and, eq } from "drizzle-orm";
import { db } from "~/lib/db";
import {
	auditEvents,
	permissions,
	rolePermissions,
	roles,
} from "~/lib/db/schema";
import { bumpRbac } from "~/lib/rbac";
import { requirePermission } from "~/lib/rbac/guards";

export const useRbacMatrix = routeLoader$(async (event) => {
	await requirePermission(event, "roles.read");
	const [allRoles, allPermissions, grants] = await Promise.all([
		db.select().from(roles).orderBy(roles.key),
		db.select().from(permissions).orderBy(permissions.key),
		db.select().from(rolePermissions),
	]);
	return {
		roles: allRoles.map((r) => ({
			id: r.id,
			key: r.key,
			displayName: r.displayName,
			isSystem: r.isSystem,
		})),
		permissions: allPermissions,
		// JSON-safe DTO (a Set can deserialize as {} over the wire)
		grants: grants.map((g) => `${g.roleId}:${g.permissionKey}`),
	};
});

export const useToggleGrant = routeAction$(async (data, event) => {
	const session = await requirePermission(event, "roles.manage");
	const roleId = String(data.roleId ?? "");
	const permissionKey = String(data.permissionKey ?? "");
	const grant = data.grant === "true";

	const [role] = await db
		.select()
		.from(roles)
		.where(eq(roles.id, roleId))
		.limit(1);
	if (!role) return { ok: false as const, error: "Unknown role." };

	// Lockout protection: the admin role can never lose admin.access or roles.manage.
	if (
		!grant &&
		role.key === "admin" &&
		(permissionKey === "admin.access" || permissionKey === "roles.manage")
	) {
		return {
			ok: false as const,
			error:
				"The admin role cannot lose admin.access or roles.manage (lockout protection).",
		};
	}

	await db.transaction(async (tx) => {
		if (grant) {
			await tx
				.insert(rolePermissions)
				.values({ roleId, permissionKey })
				.onConflictDoNothing();
		} else {
			await tx
				.delete(rolePermissions)
				.where(
					and(
						eq(rolePermissions.roleId, roleId),
						eq(rolePermissions.permissionKey, permissionKey),
					),
				);
		}
		await tx.insert(auditEvents).values({
			actorId: session.user.id,
			action: grant ? "rbac.grant" : "rbac.revoke",
			targetType: "role",
			targetId: roleId,
			after: { permissionKey },
		});
	});
	await bumpRbac();

	return { ok: true as const };
});

export default component$(() => {
	const matrix = useRbacMatrix();
	const toggle = useToggleGrant();

	return (
		<main class="p-xl grid gap-lg">
			<header>
				<h1 class="font-display text-heading m-0">Roles &amp; permissions</h1>
				<p class="text-text2 text-body m-0">
					Toggle grants per role. Changes apply within seconds on every replica
					— no redeploy.
				</p>
			</header>

			{toggle.value?.ok === false && (
				<p role="alert" class="text-error text-label m-0">
					{toggle.value.error}
				</p>
			)}

			<div class="overflow-auto">
				<table class="border-collapse text-body-sm">
					<thead>
						<tr>
							<th class="text-left text-text3 text-caption py-sm pr-md">
								Permission
							</th>
							{matrix.value.roles.map((role) => (
								<th
									key={role.id}
									class="text-left text-text3 text-caption py-sm px-sm"
								>
									{role.displayName}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{matrix.value.permissions.map((perm) => (
							<tr key={perm.key}>
								<td class="py-sm pr-md border-t border-border">
									<span class="font-mono text-text1">{perm.key}</span>
									<span class="block text-caption text-text3">
										{perm.description}
									</span>
								</td>
								{matrix.value.roles.map((role) => {
									const granted = matrix.value.grants.includes(
										`${role.id}:${perm.key}`,
									);
									return (
										<td
											key={role.id}
											class="py-sm px-sm border-t border-border"
										>
											<input
												type="checkbox"
												checked={granted}
												aria-label={`${perm.key} for ${role.displayName}`}
												class="accent-accent h-4 w-4 cursor-pointer"
												onChange$={async (e) => {
													await toggle.submit({
														roleId: role.id,
														permissionKey: perm.key,
														grant: String(
															(e.target as HTMLInputElement).checked,
														),
													});
												}}
											/>
										</td>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</main>
	);
});
