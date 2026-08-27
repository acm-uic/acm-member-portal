import { component$ } from "@builder.io/qwik";
import { Link, routeLoader$ } from "@builder.io/qwik-city";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "~/lib/db";
import { auditEvents, roles, user } from "~/lib/db/schema";
import { requirePermission } from "~/lib/rbac/guards";

const FIELD_LABELS: Record<string, string> = {
  first_name: "First name",
  last_name: "Last name",
  preferred_name: "Preferred name",
  netid: "NetID",
  username: "Username",
  uin: "UIN",
  email: "Email",
  discordId: "Discord",
  discordUsername: "Discord",
  role: "Role",
  roleId: "Role",
};

function roleDisplayName(
  roleId: unknown,
  names: Map<string, string>,
): string | null {
  if (typeof roleId !== "string" || !roleId) return null;
  return names.get(roleId) ?? roleId;
}

function roleFieldChanges(
  action: string,
  after: Record<string, unknown>,
  names: Map<string, string>,
): { field: string; oldValue: unknown; newValue: unknown }[] | null {
  if (action !== "members.role.assign" && action !== "members.role.remove") {
    return null;
  }
  const name = roleDisplayName(after.roleId, names);
  if (!name) return null;
  if (action === "members.role.assign") {
    return [{ field: "role", oldValue: null, newValue: name }];
  }
  return [{ field: "role", oldValue: name, newValue: null }];
}

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
    case "discord.link":
      return "Linked Discord";
    case "discord.unlink":
      return "Unlinked Discord";
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
      discordId: user.discordId,
      discordUsername: user.discordUsername,
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
  const roleIds = [
    ...new Set(
      rows.flatMap((e) => {
        const after = (e.after ?? {}) as Record<string, unknown>;
        const before = (e.before ?? {}) as Record<string, unknown>;
        return [after.roleId, before.roleId].filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        );
      }),
    ),
  ];
  const [actors, roleRows] = await Promise.all([
    actorIds.length
      ? db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, actorIds))
      : Promise.resolve([]),
    roleIds.length
      ? db
          .select({ id: roles.id, displayName: roles.displayName })
          .from(roles)
          .where(inArray(roles.id, roleIds))
      : Promise.resolve([]),
  ]);
  const actorName = new Map(actors.map((a) => [a.id, a.name]));
  const roleName = new Map(roleRows.map((r) => [r.id, r.displayName]));

  return {
    member: row,
    events: rows.map((e) => {
      const after = (e.after ?? {}) as Record<string, unknown>;
      const stored = after.changes as
        { field: string; oldValue: unknown; newValue: unknown }[] | undefined;
      const before = (e.before ?? {}) as Record<string, unknown>;
      const changes =
        roleFieldChanges(e.action, after, roleName) ??
        stored ??
        Object.keys({ ...before, ...after })
          .filter((k) => k !== "changes")
          .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
          .map((field) => ({
            field,
            oldValue:
              field === "roleId"
                ? roleDisplayName(before[field], roleName)
                : before[field],
            newValue:
              field === "roleId"
                ? roleDisplayName(after[field], roleName)
                : after[field],
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
          {data.value.member.username ? ` (${data.value.member.username})` : ""}
        </p>
        {data.value.member.discordId && (
          <p class="text-text3 text-body m-0">
            Discord{" "}
            <span class="font-mono">
              @
              {data.value.member.discordUsername ?? data.value.member.discordId}
            </span>
          </p>
        )}
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
                    {event.changes.map((c) => {
                      const isRole = c.field === "role" || c.field === "roleId";
                      return (
                        <tr key={c.field}>
                          <td class="py-2xs pr-sm text-text1">
                            {FIELD_LABELS[c.field] ?? c.field}
                          </td>
                          <td
                            class={`py-2xs pr-sm text-text3 ${isRole ? "" : "font-mono"}`}
                          >
                            {formatValue(c.oldValue)}
                          </td>
                          <td
                            class={`py-2xs text-text1 ${isRole ? "" : "font-mono"}`}
                          >
                            {formatValue(c.newValue)}
                          </td>
                        </tr>
                      );
                    })}
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
