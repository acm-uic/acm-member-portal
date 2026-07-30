/**
 * Permission catalog — the single typed source of truth.
 * MUST stay in sync with the seed INSERTs in drizzle/0000_initial.sql
 * (drift-checked by a Slice 4 success criterion: DB count === catalog length).
 */
export const PERMISSIONS = {
	ADMIN_ACCESS: "admin.access",
	SIGNUPS_REVIEW: "signups.review",
	SIGNUPS_APPROVE: "signups.approve",
	PROVISIONING_RETRY: "provisioning.retry",
	MEMBERS_READ: "members.read",
	MEMBERS_READ_RESTRICTED: "members.read.restricted",
	MEMBERS_MANAGE: "members.manage",
	MEMBERS_DEACTIVATE: "members.deactivate",
	ROLES_READ: "roles.read",
	ROLES_MANAGE: "roles.manage",
	FORMS_READ: "forms.read",
	FORMS_MANAGE: "forms.manage",
	CONTENT_READ: "content.read",
	CONTENT_PUBLISH: "content.publish",
	CONTENT_MANAGE: "content.manage",
	ALUMNI_REVIEW: "alumni.review",
	ALUMNI_APPROVE: "alumni.approve",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_CATALOG: ReadonlyArray<{
	key: PermissionKey;
	description: string;
}> = [
	{ key: "admin.access", description: "Access the admin panel" },
	{ key: "signups.review", description: "View pending signup submissions" },
	{ key: "signups.approve", description: "Approve or deny signup submissions" },
	{
		key: "provisioning.retry",
		description: "Retry dead-lettered provisioning events",
	},
	{ key: "members.read", description: "View member directory" },
	{
		key: "members.read.restricted",
		description: "View UIN and demographic answers",
	},
	{
		key: "members.manage",
		description: "Edit member accounts and role assignments",
	},
	{ key: "members.deactivate", description: "Deactivate member accounts" },
	{ key: "roles.read", description: "View roles and permissions" },
	{ key: "roles.manage", description: "Edit role permission grants" },
	{ key: "forms.read", description: "View signup form schemas" },
	{
		key: "forms.manage",
		description: "Create and publish signup form schemas",
	},
	{ key: "content.read", description: "Read published content" },
	{ key: "content.publish", description: "Publish hosted content" },
	{ key: "content.manage", description: "Edit and archive any hosted content" },
	{ key: "alumni.review", description: "View alumni transition suggestions" },
	{ key: "alumni.approve", description: "Approve alumni transitions" },
];
