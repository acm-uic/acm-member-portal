import { describe, expect, it } from "vitest";
import { unionPermissions } from "./union";
import { PERMISSION_CATALOG, PERMISSIONS } from "./permissions";

describe("permission catalog", () => {
	it("contains exactly the 17 seeded keys", () => {
		expect(PERMISSION_CATALOG).toHaveLength(17);
	});

	it("has unique keys", () => {
		expect(new Set(PERMISSION_CATALOG.map((p) => p.key)).size).toBe(
			PERMISSION_CATALOG.length,
		);
	});

	it("includes the FRD-mandated keys", () => {
		const keys = new Set(PERMISSION_CATALOG.map((p) => p.key));
		for (const required of [
			PERMISSIONS.ADMIN_ACCESS,
			PERMISSIONS.SIGNUPS_APPROVE,
			PERMISSIONS.ROLES_MANAGE,
			PERMISSIONS.FORMS_MANAGE,
			PERMISSIONS.CONTENT_PUBLISH,
			PERMISSIONS.ALUMNI_APPROVE,
			PERMISSIONS.MEMBERS_READ_RESTRICTED,
		]) {
			expect(keys.has(required)).toBe(true);
		}
	});
});

describe("unionPermissions", () => {
	const sets = new Map<
		string,
		Set<(typeof PERMISSIONS)[keyof typeof PERMISSIONS]>
	>([
		["role-a", new Set(["content.read", "members.read"])],
		["role-b", new Set(["content.read", "signups.review"])],
	]);

	it("unions permissions across all of a user's roles", () => {
		const out = unionPermissions(["role-a", "role-b"], sets);
		expect([...out].sort()).toEqual([
			"content.read",
			"members.read",
			"signups.review",
		]);
	});

	it("returns an empty set for no memberships", () => {
		expect(unionPermissions([], sets).size).toBe(0);
	});

	it("ignores memberships whose role has no grants", () => {
		expect(unionPermissions(["role-missing"], sets).size).toBe(0);
	});
});
