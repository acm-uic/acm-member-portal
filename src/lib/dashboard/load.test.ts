import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ db: {} }));
import { personalMetricsFromProfile } from "./load";

describe("member account status", () => {
  it("reports AD provisioning independently from active membership", () => {
    const profile = { status: "active", adProvisioningStatus: "pending" };
    expect(personalMetricsFromProfile(profile)).toMatchObject({
      membership: "Active",
      provisioning: { label: "Pending", tone: "warning" },
    });
    expect(
      personalMetricsFromProfile({
        ...profile,
        adProvisioningStatus: "failed",
      }),
    ).toMatchObject({
      membership: "Active",
      provisioning: { label: "Failed", tone: "error" },
    });
    expect(
      personalMetricsFromProfile({
        ...profile,
        adProvisioningStatus: "provisioned",
      }),
    ).toMatchObject({
      membership: "Active",
      provisioning: { label: "Provisioned", tone: "success" },
    });
  });

  it("does not treat a missing member profile as provisioned", () => {
    expect(personalMetricsFromProfile(null)).toMatchObject({
      membership: "Inactive",
      provisioning: { label: "Pending", tone: "warning" },
    });
  });
});
