import { describe, expect, it } from "vitest";

import { setMerchantSubscription } from "@/modules/billing-entitlement/service";
import { createMembership } from "@/modules/membership/service";
import { createBranch } from "@/modules/merchant/service";
import { ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { createStaffUser } from "@/modules/staff/service";

import { createMerchantFixture, createSuperAdminFixture, createTestAuthUser } from "./setup";

/**
 * Entitlement Limit Enforcement (§37.3, Phase 9 Blocker 3, Locked — Option A). Covers: hard-limit
 * blocking at the exact boundary, unlimited (`null`) never blocking, `staffLimit` correctly
 * excluding the Owner, and the race-condition safety the transaction-scoped `count()` check
 * exists for.
 */
describe("Entitlement Limit Enforcement — memberLimit (§37.3)", () => {
  it("blocks creating a new member once at the limit, and never blocks reads of existing members", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { memberLimit: 1 }, reason: "test limit" });

    await createMembership(ownerCtx, { displayName: "First (allowed)" });
    await expect(createMembership(ownerCtx, { displayName: "Second (blocked)" })).rejects.toThrow(ValidationError);

    const snap = await getDb().collection(COLLECTIONS.memberships).where("merchantId", "==", merchantId).get();
    expect(snap.size).toBe(1); // the blocked attempt never partially wrote anything
  });

  it("a null (unlimited) memberLimit never blocks, even after a lower limit was hit", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { memberLimit: 1 }, reason: "start low" });
    await createMembership(ownerCtx, { displayName: "First" });
    await expect(createMembership(ownerCtx, { displayName: "Second (blocked)" })).rejects.toThrow(ValidationError);

    // `SubscriptionOverrides.memberLimit` is typed `number | undefined` (no service-layer path
    // ever sets it to `null`) — writing `null` directly here exercises the defensive
    // `limit === null` branch in `enforceEntitlementLimitTx` the same way a future
    // package/override shape change legitimately could.
    await getDb().collection(COLLECTIONS.subscriptions).doc(merchantId).update({ "overrides.memberLimit": null });

    await createMembership(ownerCtx, { displayName: "Third (unlimited now)" });
    await createMembership(ownerCtx, { displayName: "Fourth (still unlimited)" });
  });

  it("two concurrent createMembership calls at the boundary never both succeed (no race)", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { memberLimit: 1 }, reason: "race test" });

    const results = await Promise.allSettled([
      createMembership(ownerCtx, { displayName: "Race A" }),
      createMembership(ownerCtx, { displayName: "Race B" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const snap = await getDb().collection(COLLECTIONS.memberships).where("merchantId", "==", merchantId).get();
    expect(snap.size).toBe(1); // never 2 — the hard limit is honored even under contention
  });
});

describe("Entitlement Limit Enforcement — staffLimit excludes the Owner (§37.3)", () => {
  it("the Owner (bootstrap path) never counts against staffLimit", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { staffLimit: 1 }, reason: "test limit" });

    // The Owner already exists (created via createMerchantWithOwner) — staffLimit=1 must still
    // allow exactly ONE MANAGER/STAFF addition, not zero.
    const authUid = await createTestAuthUser("entitlement-staff");
    await createStaffUser(ownerCtx, { authUid, role: "STAFF" });

    const authUid2 = await createTestAuthUser("entitlement-staff-2");
    await expect(createStaffUser(ownerCtx, { authUid: authUid2, role: "STAFF" })).rejects.toThrow(ValidationError);
  });
});

describe("Entitlement Limit Enforcement — branchLimit (§37.3)", () => {
  it("blocks creating a new branch once at the limit (the default branch already counts)", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx, merchantId } = await createMerchantFixture();
    // createMerchantWithOwner already creates one default branch — limit=1 means no MORE branches.
    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { branchLimit: 1 }, reason: "test limit" });

    await expect(createBranch(ownerCtx, { merchantId, name: "Second branch", address: "" })).rejects.toThrow(ValidationError);
  });

  it("raising the limit via a Super Admin override immediately unblocks new creation", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { branchLimit: 1 }, reason: "test limit" });
    await expect(createBranch(ownerCtx, { merchantId, name: "Blocked branch", address: "" })).rejects.toThrow(ValidationError);

    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { branchLimit: 2 }, reason: "upgrade" });
    await expect(createBranch(ownerCtx, { merchantId, name: "Now allowed", address: "" })).resolves.toEqual(expect.any(String));
  });
});

describe("Entitlement Limit Enforcement — cross-tenant scoping (§3, §37.3)", () => {
  it("merchant A's limit never affects merchant B's ability to create resources", async () => {
    const admin = await createSuperAdminFixture();
    const merchantA = await createMerchantFixture("Entitlement A");
    const merchantB = await createMerchantFixture("Entitlement B");
    await setMerchantSubscription(admin.ctx, merchantA.merchantId, { overrides: { memberLimit: 0 }, reason: "block A entirely" });

    await expect(createMembership(merchantA.ownerCtx, { displayName: "Blocked in A" })).rejects.toThrow(ValidationError);
    await expect(createMembership(merchantB.ownerCtx, { displayName: "Allowed in B" })).resolves.toEqual(expect.any(String));
  });
});
