import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import { addManualPoints } from "@/modules/points/ledger-service";
import { findBalanceMismatchesForMerchant } from "@/modules/reconciliation/service";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createMerchantFixture, uniqueId } from "./setup";

/**
 * Balance Reconciliation (Safety Net) — §12, §38.4 (Phase 10, gap fix). Strictly read-only:
 * detects `membership.pointsBalance` vs. `Σ pointsLots.remainingAmount` drift, never corrects it.
 */
describe("findBalanceMismatchesForMerchant (§38.4)", () => {
  it("reports no mismatches when the cache agrees with the lot sum", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Reconciled Member" });
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 25,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });

    const mismatches = await findBalanceMismatchesForMerchant(merchantId);
    expect(mismatches).toHaveLength(0);
  });

  it("detects a deliberately corrupted cached balance, and leaves the underlying data untouched", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Corrupted Member" });
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 25,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });

    // Simulate drift by writing directly to the membership doc, bypassing the service layer
    // entirely (the only way this could happen in practice would be a bug elsewhere — this test
    // exists precisely to catch that class of bug).
    await getDb().collection(COLLECTIONS.memberships).doc(membershipId).update({ pointsBalance: 999 });

    const mismatches = await findBalanceMismatchesForMerchant(merchantId);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ membershipId, cachedBalance: 999, computedBalance: 25 });

    // Read-only guarantee (§38.4): the job must never auto-correct anything.
    const membershipSnap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((membershipSnap.data() as { pointsBalance: number }).pointsBalance).toBe(999); // untouched
    const lotsSnap = await getDb()
      .collection(COLLECTIONS.pointsLots)
      .where("merchantId", "==", merchantId)
      .where("membershipId", "==", membershipId)
      .get();
    expect(lotsSnap.docs.every((d) => (d.data() as { remainingAmount: number }).remainingAmount === 25)).toBe(true);
  });

  it("never scans or reports another merchant's memberships (tenant isolation)", async () => {
    const merchantA = await createMerchantFixture("Reconciliation A");
    const merchantB = await createMerchantFixture("Reconciliation B");
    const memberA = await createMembership(merchantA.ownerCtx, { displayName: "Member A" });
    await addManualPoints(merchantA.ownerCtx, {
      membershipId: memberA,
      branchId: null,
      amount: 10,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });
    await getDb().collection(COLLECTIONS.memberships).doc(memberA).update({ pointsBalance: 12345 });

    const memberB = await createMembership(merchantB.ownerCtx, { displayName: "Member B" });
    await addManualPoints(merchantB.ownerCtx, {
      membershipId: memberB,
      branchId: null,
      amount: 10,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });

    const mismatchesA = await findBalanceMismatchesForMerchant(merchantA.merchantId);
    const mismatchesB = await findBalanceMismatchesForMerchant(merchantB.merchantId);
    expect(mismatchesA).toHaveLength(1);
    expect(mismatchesA[0].membershipId).toBe(memberA);
    expect(mismatchesB).toHaveLength(0); // merchant B's clean data is never affected by A's corruption
  });
});
