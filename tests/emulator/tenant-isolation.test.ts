import { describe, expect, it } from "vitest";

import { resolveEntitlement } from "@/modules/billing-entitlement/service";
import { createMembership, getMembership, listMemberships } from "@/modules/membership/service";
import { getMerchant, listBranches } from "@/modules/merchant/service";
import { TenantIsolationError } from "@/modules/shared/errors";
import { createStaffUser, listStaff } from "@/modules/staff/service";

import { addStaffFixture, createMerchantFixture, createTestAuthUser } from "./setup";

/**
 * Cross-tenant access must be denied in every direction (FINAL-ARCHITECTURE.md §3, §26 threat
 * checklist), exercised entirely through the real service layer against two independently
 * created merchants on the emulator.
 *
 * Note on "forged merchantId in request payload": none of this codebase's service functions
 * accept a `merchantId` parameter that overrides the caller's own `ctx.merchantId` — merchantId
 * is always derived from the verified `AuthContext`, never from caller input (§3, §10). There is
 * therefore no code path to even attempt sending a forged merchantId; that guarantee is
 * structural, not merely tested. The tests below cover the other injection vector: a *target
 * resource id* the caller doesn't own (forged/guessed membershipId, branchId, merchantId, ...).
 */
describe("Tenant isolation across two independently created merchants (emulator)", () => {
  it("Owner B cannot read a membership belonging to Merchant A by id", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");

    const membershipIdA = await createMembership(merchantA.ownerCtx, { displayName: "Somchai A" });

    await expect(getMembership(merchantB.ownerCtx, membershipIdA)).rejects.toThrow(
      TenantIsolationError,
    );
    // Merchant A's own owner can still read it.
    await expect(getMembership(merchantA.ownerCtx, membershipIdA)).resolves.toMatchObject({
      merchantId: merchantA.merchantId,
    });
  });

  it("listMemberships never returns another merchant's memberships", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");

    await createMembership(merchantA.ownerCtx, { displayName: "Somchai A" });
    await createMembership(merchantA.ownerCtx, { displayName: "Somsri A" });
    await createMembership(merchantB.ownerCtx, { displayName: "Malee B" });

    const listA = await listMemberships(merchantA.ownerCtx);
    const listB = await listMemberships(merchantB.ownerCtx);

    expect(listA.memberships.every((m) => m.merchantId === merchantA.merchantId)).toBe(true);
    expect(listB.memberships.every((m) => m.merchantId === merchantB.merchantId)).toBe(true);
    expect(listB.memberships.some((m) => m.merchantId === merchantA.merchantId)).toBe(false);
  });

  it("Owner B cannot read Merchant A's settings or branch list by guessing the id", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");

    await expect(getMerchant(merchantB.ownerCtx, merchantA.merchantId)).rejects.toThrow(
      TenantIsolationError,
    );
    await expect(listBranches(merchantB.ownerCtx, merchantA.merchantId)).rejects.toThrow(
      TenantIsolationError,
    );
  });

  it("Owner B cannot read Merchant A's entitlement/subscription info by guessing the id", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");

    await expect(resolveEntitlement(merchantB.ownerCtx, merchantA.merchantId)).rejects.toThrow(
      TenantIsolationError,
    );
    await expect(
      resolveEntitlement(merchantA.ownerCtx, merchantA.merchantId),
    ).resolves.toMatchObject({ memberLimit: expect.any(Number) });
  });

  it("Staff of merchant B cannot see or manage staff of merchant A", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const staffB = await addStaffFixture(merchantB.ownerCtx, "STAFF");

    // Each merchant's own staff list only ever contains its own staff.
    const staffOfA = await listStaff(merchantA.ownerCtx);
    const staffOfB = await listStaff(merchantB.ownerCtx);
    expect(staffOfA.some((s) => s.authUid === staffB.authUid)).toBe(false);
    expect(staffOfB.every((s) => s.merchantId === merchantB.merchantId)).toBe(true);

    const forgedAuthUid = await createTestAuthUser("forged");
    // staffB (role STAFF) trying to manage staff at all is an AuthorizationError, but the more
    // important structural guarantee: there is no `merchantId` parameter on createStaffUser to
    // even target merchant A with — it always writes under staffB.ctx.merchantId (=== merchantB).
    await expect(
      createStaffUser(staffB.ctx, { authUid: forgedAuthUid, role: "STAFF" }),
    ).rejects.toThrow();
  });

  it("a membership created via one merchant's ctx is always stamped with that merchant's id, never a caller-supplied one", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const membershipId = await createMembership(merchantA.ownerCtx, { displayName: "Somchai" });
    const loaded = await getMembership(merchantA.ownerCtx, membershipId);
    expect(loaded.merchantId).toBe(merchantA.merchantId);
  });
});
