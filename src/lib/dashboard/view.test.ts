import { describe, expect, it } from "vitest";
import {
	defaultDashboardView,
	isDashboardView,
	isStaff,
	resolveDashboardView,
} from "./view";

describe("defaultDashboardView", () => {
	it("prioritizes staff over other roles", () => {
		expect(
			defaultDashboardView(["member", "sig_leader", "officer"]),
		).toBe("staff");
		expect(defaultDashboardView(["moderator"])).toBe("staff");
		expect(defaultDashboardView(["admin", "alumni"])).toBe("staff");
	});

	it("falls through to sig_leader, alumni, then member", () => {
		expect(defaultDashboardView(["sig_leader", "member"])).toBe("sig_leader");
		expect(defaultDashboardView(["alumni"])).toBe("alumni");
		expect(defaultDashboardView(["member"])).toBe("member");
		expect(defaultDashboardView([])).toBe("member");
	});
});

describe("resolveDashboardView", () => {
	it("ignores preview cookies for non-Staff users", () => {
		expect(resolveDashboardView(["member"], "staff")).toEqual({
			view: "member",
			canPreview: false,
			isPreview: false,
		});
		expect(resolveDashboardView(["alumni"], "sig_leader")).toEqual({
			view: "alumni",
			canPreview: false,
			isPreview: false,
		});
		expect(resolveDashboardView(["sig_leader"], "member")).toEqual({
			view: "sig_leader",
			canPreview: false,
			isPreview: false,
		});
	});

	it("lets Staff preview any valid view via cookie", () => {
		expect(resolveDashboardView(["officer"], "member")).toEqual({
			view: "member",
			canPreview: true,
			isPreview: true,
		});
		expect(resolveDashboardView(["admin"], "alumni")).toEqual({
			view: "alumni",
			canPreview: true,
			isPreview: true,
		});
		expect(resolveDashboardView(["moderator"], "sig_leader")).toEqual({
			view: "sig_leader",
			canPreview: true,
			isPreview: true,
		});
		expect(resolveDashboardView(["officer"], "staff")).toEqual({
			view: "staff",
			canPreview: true,
			isPreview: false,
		});
	});

	it("falls back to default when cookie is missing or invalid", () => {
		expect(resolveDashboardView(["officer"], null)).toEqual({
			view: "staff",
			canPreview: true,
			isPreview: false,
		});
		expect(resolveDashboardView(["officer"], "nope")).toEqual({
			view: "staff",
			canPreview: true,
			isPreview: false,
		});
	});
});

describe("helpers", () => {
	it("detects staff role keys and valid views", () => {
		expect(isStaff(["member"])).toBe(false);
		expect(isStaff(["moderator", "member"])).toBe(true);
		expect(isDashboardView("staff")).toBe(true);
		expect(isDashboardView("guest")).toBe(false);
	});
});
