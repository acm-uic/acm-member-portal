import { describe, expect, it } from "vitest";
import { roleChangeBlocked } from "./role-assign";

const admin = {
	actorUserId: "admin-1",
	actorRoleKeys: ["admin", "member"],
	actorPermissions: ["members.manage", "members.read"],
	targetUserId: "user-2",
	targetRoleKeys: ["member"],
	adminUserIds: ["admin-1"],
	roleKey: "officer",
	assign: true,
};

describe("roleChangeBlocked", () => {
	it("blocks anyone without members.manage", () => {
		expect(
			roleChangeBlocked({
				...admin,
				actorPermissions: ["members.read"],
			}),
		).toMatch(/permission/i);
	});

	it("blocks assigning Admin unless the actor is an Admin", () => {
		expect(
			roleChangeBlocked({
				...admin,
				actorRoleKeys: ["officer", "member"],
				roleKey: "admin",
				assign: true,
			}),
		).toMatch(/Admin/);
	});

	it("blocks removing Admin from your own account", () => {
		expect(
			roleChangeBlocked({
				...admin,
				targetUserId: "admin-1",
				targetRoleKeys: ["admin", "member"],
				roleKey: "admin",
				assign: false,
			}),
		).toMatch(/your own account/);
	});

	it("blocks removing the last Admin", () => {
		expect(
			roleChangeBlocked({
				...admin,
				targetUserId: "admin-2",
				targetRoleKeys: ["admin", "member"],
				adminUserIds: ["admin-2"],
				roleKey: "admin",
				assign: false,
			}),
		).toMatch(/last Admin/);
	});

	it("allows an Admin to grant Officer", () => {
		expect(roleChangeBlocked(admin)).toBeNull();
	});

	it("allows an Admin to grant Admin to someone else", () => {
		expect(
			roleChangeBlocked({
				...admin,
				roleKey: "admin",
				assign: true,
			}),
		).toBeNull();
	});
});
