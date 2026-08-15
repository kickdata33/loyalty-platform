import { describe, expect, it } from "vitest";

import { requireBranchScope, requireOwner, requirePermission } from "@/modules/rbac/authorization-service";
import { hasPermission, PERMISSIONS } from "@/modules/rbac/permission-matrix";
import { AuthorizationError, TenantIsolationError } from "@/modules/shared/errors";
import type { AuthContext } from "@/modules/shared/types";

function ctx(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    authUid: "auth-uid-1",
    merchantId: "merchant-a",
    role: "STAFF",
    staffUserId: "staff-1",
    branchScope: [],
    ...overrides,
  };
}

describe("Permission Matrix V1 (LOCKED) — role defaults", () => {
  it("grants Owner every permission", () => {
    for (const permission of Object.values(PERMISSIONS)) {
      expect(hasPermission("OWNER", permission)).toBe(true);
    }
  });

  it("denies Manager the four explicit Owner-only powers", () => {
    expect(hasPermission("MANAGER", PERMISSIONS.PERMISSION_MANAGE)).toBe(false);
    expect(hasPermission("MANAGER", PERMISSIONS.LINE_CONNECTION_MANAGE)).toBe(false);
    expect(hasPermission("MANAGER", PERMISSIONS.BILLING_MANAGE)).toBe(false);
    expect(hasPermission("MANAGER", PERMISSIONS.MERCHANT_LIFECYCLE_MANAGE)).toBe(false);
  });

  it("grants Manager everything else (full operational control)", () => {
    expect(hasPermission("MANAGER", PERMISSIONS.POINTS_ADJUST)).toBe(true);
    expect(hasPermission("MANAGER", PERMISSIONS.POINTS_REVERSE)).toBe(true);
    expect(hasPermission("MANAGER", PERMISSIONS.STAFF_MANAGE)).toBe(true);
    expect(hasPermission("MANAGER", PERMISSIONS.BROADCAST_SEND)).toBe(true);
    expect(hasPermission("MANAGER", PERMISSIONS.REPORT_VIEW)).toBe(true);
  });

  it("limits Staff to counter operations only", () => {
    const allowed = [
      PERMISSIONS.MEMBER_VIEW,
      PERMISSIONS.MEMBER_SEARCH,
      PERMISSIONS.MEMBER_CREATE,
      PERMISSIONS.POINTS_ADD_RULE,
      PERMISSIONS.POINTS_ADD_MANUAL,
      PERMISSIONS.POINTS_VIEW_HISTORY,
      PERMISSIONS.REWARD_REDEEM,
      PERMISSIONS.COUPON_REDEEM,
    ];
    for (const p of allowed) expect(hasPermission("STAFF", p)).toBe(true);

    const denied = [
      PERMISSIONS.POINTS_ADJUST,
      PERMISSIONS.POINTS_REVERSE,
      PERMISSIONS.REWARD_MANAGE,
      PERMISSIONS.COUPON_MANAGE,
      PERMISSIONS.PROMOTION_MANAGE,
      PERMISSIONS.AUTOMATION_MANAGE,
      PERMISSIONS.BROADCAST_SEND,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.STAFF_ACTIVITY_VIEW,
      PERMISSIONS.STAFF_MANAGE,
      PERMISSIONS.PERMISSION_MANAGE,
      PERMISSIONS.MERCHANT_SETTINGS_MANAGE,
      PERMISSIONS.LINE_CONNECTION_MANAGE,
      PERMISSIONS.BILLING_MANAGE,
    ];
    for (const p of denied) expect(hasPermission("STAFF", p)).toBe(false);
  });

  it("permissionOverrides grant on top of the role default, never revoke", () => {
    expect(hasPermission("STAFF", PERMISSIONS.BROADCAST_SEND)).toBe(false);
    expect(hasPermission("STAFF", PERMISSIONS.BROADCAST_SEND, [PERMISSIONS.BROADCAST_SEND])).toBe(
      true,
    );
    // A role-default permission stays granted even if it doesn't appear in overrides.
    expect(hasPermission("STAFF", PERMISSIONS.MEMBER_VIEW, [])).toBe(true);
  });
});

describe("requirePermission()", () => {
  it("throws TenantIsolationError before ever evaluating the permission, on a merchant mismatch", () => {
    const staffCtx = ctx({ role: "STAFF", merchantId: "merchant-a" });
    expect(() =>
      requirePermission(staffCtx, PERMISSIONS.MEMBER_VIEW, "merchant-b"),
    ).toThrow(TenantIsolationError);
  });

  it("throws AuthorizationError (not TenantIsolationError) for same-tenant, wrong-role calls", () => {
    const staffCtx = ctx({ role: "STAFF", merchantId: "merchant-a" });
    expect(() =>
      requirePermission(staffCtx, PERMISSIONS.POINTS_ADJUST, "merchant-a"),
    ).toThrow(AuthorizationError);
  });

  it("allows a matching-tenant, permitted-role call to pass without throwing", () => {
    const ownerCtx = ctx({ role: "OWNER", merchantId: "merchant-a" });
    expect(() => requirePermission(ownerCtx, PERMISSIONS.POINTS_ADJUST, "merchant-a")).not.toThrow();
  });
});

describe("requireOwner()", () => {
  it("throws TenantIsolationError on merchant mismatch even for an Owner", () => {
    const ownerCtx = ctx({ role: "OWNER", merchantId: "merchant-a" });
    expect(() => requireOwner(ownerCtx, "merchant-b")).toThrow(TenantIsolationError);
  });

  it("throws AuthorizationError for a same-tenant Manager", () => {
    const managerCtx = ctx({ role: "MANAGER", merchantId: "merchant-a" });
    expect(() => requireOwner(managerCtx, "merchant-a")).toThrow(AuthorizationError);
  });

  it("passes for a same-tenant Owner", () => {
    const ownerCtx = ctx({ role: "OWNER", merchantId: "merchant-a" });
    expect(() => requireOwner(ownerCtx, "merchant-a")).not.toThrow();
  });
});

describe("requireBranchScope()", () => {
  it("allows any branch when branchScope is empty (unrestricted)", () => {
    expect(() => requireBranchScope({ branchScope: [] }, "branch-x")).not.toThrow();
  });

  it("denies a branch not included in a non-empty branchScope", () => {
    expect(() => requireBranchScope({ branchScope: ["branch-a"] }, "branch-b")).toThrow(
      AuthorizationError,
    );
  });

  it("allows a branch included in branchScope", () => {
    expect(() =>
      requireBranchScope({ branchScope: ["branch-a", "branch-b"] }, "branch-b"),
    ).not.toThrow();
  });
});
