import { sql } from "drizzle-orm";
import {
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

/* ================= better-auth core tables =================
   Keep in lockstep with `npx auth@latest generate` (verified by Slice 3 criteria).
   Column names/types are what better-auth@1.6 expects. */

export const user = pgTable("user", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").notNull().default(false),
	image: text("image"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	/* additionalFields — see src/lib/auth.ts user.additionalFields */
	netid: text("netid").unique(),
	username: text("username").unique(),
	uin: text("uin"),
	firstName: text("first_name"),
	lastName: text("last_name"),
	preferredName: text("preferred_name"),
	displayName: text("display_name"),
	entraOid: text("entra_oid"),
});

export const session = pgTable("session", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	token: text("token").notNull().unique(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const account = pgTable("account", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", {
		withTimezone: true,
	}),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
		withTimezone: true,
	}),
	scope: text("scope"),
	idToken: text("id_token"),
	password: text("password"),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const verification = pgTable("verification", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

/* ================= domain tables ================= */

export const formSchemas = pgTable(
	"form_schemas",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		formKey: text("form_key").notNull(),
		version: integer("version").notNull(),
		status: text("status", { enum: ["draft", "published", "archived"] })
			.notNull()
			.default("draft"),
		season: text("season"),
		fields: jsonb("fields").notNull(),
		createdBy: text("created_by").references(() => user.id),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [unique("form_schemas_form_key_version_key").on(t.formKey, t.version)],
);

export const memberProfiles = pgTable(
	"member_profiles",
	{
		userId: text("user_id")
			.primaryKey()
			.references(() => user.id, { onDelete: "cascade" }),
		answers: jsonb("answers").notNull().default({}),
		answersSchemaVersionId: uuid("answers_schema_version_id").references(
			() => formSchemas.id,
		),
		adProvisioningStatus: text("ad_provisioning_status", {
			enum: ["pending", "provisioned", "failed"],
		})
			.notNull()
			.default("pending"),
		provisionedAt: timestamp("provisioned_at", { withTimezone: true }),
		status: text("status", { enum: ["active", "deactivated"] })
			.notNull()
			.default("active"),
		deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
		deactivatedBy: text("deactivated_by").references(() => user.id),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		index("member_profiles_grad_year_idx").using(
			"btree",
			sql`((answers->>'grad_year'))`,
		),
		index("member_profiles_status_idx").on(t.status),
	],
);

export const signupSubmissions = pgTable(
	"signup_submissions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		schemaVersionId: uuid("schema_version_id")
			.notNull()
			.references(() => formSchemas.id),
		firstName: text("first_name").notNull(),
		lastName: text("last_name").notNull(),
		preferredName: text("preferred_name"),
		netid: text("netid").notNull(),
		username: text("username").notNull(),
		uin: text("uin"),
		email: text("email").notNull(),
		answers: jsonb("answers").notNull(),
		status: text("status", { enum: ["pending", "approved", "denied"] })
			.notNull()
			.default("pending"),
		reviewedBy: text("reviewed_by").references(() => user.id),
		reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
		denialReason: text("denial_reason"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("signup_submissions_status_idx").on(t.status)],
);

export const permissions = pgTable("permissions", {
	key: text("key").primaryKey(),
	description: text("description").notNull(),
});

export const roles = pgTable("roles", {
	id: uuid("id").primaryKey().defaultRandom(),
	key: text("key").notNull().unique(),
	displayName: text("display_name").notNull(),
	isSystem: boolean("is_system").notNull().default(false),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const rolePermissions = pgTable(
	"role_permissions",
	{
		roleId: uuid("role_id")
			.notNull()
			.references(() => roles.id, { onDelete: "cascade" }),
		permissionKey: text("permission_key")
			.notNull()
			.references(() => permissions.key, { onDelete: "cascade" }),
	},
	(t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

export const userRoles = pgTable(
	"user_roles",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		roleId: uuid("role_id")
			.notNull()
			.references(() => roles.id, { onDelete: "cascade" }),
		assignedBy: text("assigned_by").references(() => user.id),
		assignedAt: timestamp("assigned_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const contentItems = pgTable(
	"content_items",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		type: text("type", {
			enum: ["announcement", "document", "meeting_note"],
		}).notNull(),
		title: text("title").notNull(),
		body: text("body"),
		status: text("status", { enum: ["draft", "published", "archived"] })
			.notNull()
			.default("draft"),
		authorId: text("author_id").references(() => user.id),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("content_items_type_status_idx").on(t.type, t.status)],
);

export const sigs = pgTable("sigs", {
	id: uuid("id").primaryKey().defaultRandom(),
	key: text("key").notNull().unique(),
	displayName: text("display_name").notNull(),
	active: boolean("active").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

export const sigLeaders = pgTable(
	"sig_leaders",
	{
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		sigId: uuid("sig_id")
			.notNull()
			.references(() => sigs.id, { onDelete: "cascade" }),
		assignedBy: text("assigned_by").references(() => user.id),
		assignedAt: timestamp("assigned_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.sigId] }),
		index("sig_leaders_sig_id_idx").on(t.sigId),
	],
);

export const auditEvents = pgTable(
	"audit_events",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		actorId: text("actor_id").references(() => user.id),
		action: text("action").notNull(),
		targetType: text("target_type").notNull(),
		targetId: text("target_id"),
		before: jsonb("before"),
		after: jsonb("after"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("audit_events_target_idx").on(t.targetType, t.targetId)],
);

export const provisioningEvents = pgTable(
	"provisioning_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		submissionId: uuid("submission_id")
			.notNull()
			.references(() => signupSubmissions.id),
		payload: jsonb("payload").notNull(),
		status: text("status", {
			enum: ["pending", "processing", "provisioned", "failed", "dead_lettered"],
		})
			.notNull()
			.default("pending"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastError: text("last_error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [index("provisioning_events_claim_idx").on(t.status, t.nextAttemptAt)],
);

export const schema = {
	user,
	session,
	account,
	verification,
	formSchemas,
	memberProfiles,
	signupSubmissions,
	permissions,
	roles,
	rolePermissions,
	userRoles,
	contentItems,
	sigs,
	sigLeaders,
	auditEvents,
	provisioningEvents,
};
