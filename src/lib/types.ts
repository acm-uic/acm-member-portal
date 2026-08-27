/** Shared domain types. Data-model source of truth is src/lib/db/schema.ts (Slice 2);
    these are the wire/DTO shapes and cross-component contracts. */

export type ThemeMode = "dark" | "light";

/* ---- Dynamic signup form (Slice 5) ---- */

export type FormFieldType =
	| "text"
	| "email"
	| "number"
	| "select"
	| "multiselect"
	| "checkbox"
	| "textarea";

export interface FormFieldOption {
	value: string;
	label: string;
}

export interface FormFieldDef {
	key: string;
	label: string;
	type: FormFieldType;
	required: boolean;
	order: number;
	options?: FormFieldOption[];
	placeholder?: string;
	helpText?: string;
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
}

/** Shape of the `fields` JSONB column on form_schemas. */
export interface FormSchemaDefinition {
	fields: FormFieldDef[];
}

export type SignupStatus = "pending" | "approved" | "denied";

/* ---- Auth session payload carried in Qwik sharedMap (Slice 3) ---- */

export interface SessionUser {
	id: string;
	name: string;
	email: string;
	netid: string | null;
	username: string | null;
	entraOid: string | null;
}

export interface PortalSession {
	user: SessionUser;
	sessionId: string;
	expiresAt: Date;
}

/* ---- Provisioning (Slices 6-7): Windows API wire contract ---- */

export interface ProvisioningApiCreateRequest {
	netid: string;
	/** ACM account name → AD sAMAccountName and the local part of UserPrincipalName. */
	username: string;
	firstName: string;
	lastName: string;
	/** Preferred name when set; omitted when blank. */
	preferredName?: string;
	/** Preferred name, or "First Last" — maps to AD DisplayName. */
	displayName: string;
	email: string;
	/** UIN → AD EmployeeID. */
	uin?: string;
	/** Major → AD Department. */
	department?: string;
	/** College → AD Company. */
	company?: string;
	/** Outbox event UUID — correlation only; not written to AD. */
	eventId: string;
}

export interface ProvisioningApiUpdateRequest {
	/** Current sAMAccountName, used to find the AD object. */
	samAccountName: string;
	username?: string;
	firstName?: string;
	lastName?: string;
	preferredName?: string;
	displayName?: string;
	email?: string;
	uin?: string;
}

export interface ProvisioningApiCreateResponse {
	samAccountName: string;
	existed: boolean;
	/** Present only when a new account was created. Never persisted by the portal. */
	oneTimePassword?: string;
}

export type ProvisioningEventStatus =
	| "pending"
	| "processing"
	| "provisioned"
	| "failed"
	| "dead_lettered";

export type AdProvisioningStatus = "pending" | "provisioned" | "failed";

/* ---- Content (Slice 10) ---- */

export type ContentType = "announcement" | "document" | "meeting_note";
export type ContentStatus = "draft" | "published" | "archived";
