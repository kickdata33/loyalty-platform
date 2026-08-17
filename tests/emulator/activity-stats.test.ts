import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import { addManualPoints, earnPointsByRule } from "@/modules/points/ledger-service";
import { createPointRule } from "@/modules/points/rule-engine";
import { createRewardTemplate, confirmVoucherUse, redeemReward } from "@/modules/reward/service";
import { createCouponTemplate, issueCouponManual, redeemCoupon } from "@/modules/coupon/service";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createMerchantFixture, uniqueId } from "./setup";

/**
 * §15 "Activity Stats Maintenance" (Phase 8 Architecture Decision, Locked) — verifies
 * `recordVisit()` (§12/§13/§14's five call sites: rule-based Earn, Reward Redeem, Reward Use,
 * Coupon Manual Issue, Coupon Redeem) now actually maintains `membership.activityStats.
 * {firstVisitAt, lastVisitAt}` on a real visit, which — before this Phase 8 fix — sat frozen at
 * their Phase 3 defaults (`null`/`null`) forever (documented Known Limitation, §15 lock rationale).
 * `visitCount30d`/`visitCount90d` (the ROLLING-window half of the same decision) are covered
 * separately in `report-generation.test.ts` alongside `dailyAutomationBatch`'s own recompute step,
 * since they're deliberately NOT updated by `recordVisit` itself (§15).
 */

async function activityStatsOf(membershipId: string) {
  const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
  return (snap.data() as { activityStats: { firstVisitAt: FirebaseFirestore.Timestamp | null; lastVisitAt: FirebaseFirestore.Timestamp | null } })
    .activityStats;
}

describe("recordVisit — activityStats.firstVisitAt/lastVisitAt maintenance (§15, Phase 8 Locked)", () => {
  it("a brand-new membership starts with firstVisitAt/lastVisitAt both null", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Somchai" });
    const stats = await activityStatsOf(membershipId);
    expect(stats.firstVisitAt).toBeNull();
    expect(stats.lastVisitAt).toBeNull();
  });

  it("rule-based Earn (earnPointsByRule) sets firstVisitAt on the FIRST visit, then only advances lastVisitAt on the SECOND", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Somchai" });
    await createPointRule(ownerCtx, { name: "เข้าร้าน", type: "PER_VISIT", config: { pointsPerVisit: 10 } });

    await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });
    const afterFirst = await activityStatsOf(membershipId);
    expect(afterFirst.firstVisitAt).not.toBeNull();
    expect(afterFirst.lastVisitAt).not.toBeNull();
    expect(afterFirst.firstVisitAt!.toMillis()).toBe(afterFirst.lastVisitAt!.toMillis());

    await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });
    const afterSecond = await activityStatsOf(membershipId);
    // firstVisitAt must NEVER move once set...
    expect(afterSecond.firstVisitAt!.toMillis()).toBe(afterFirst.firstVisitAt!.toMillis());
    // ...but lastVisitAt must advance to (or past) the second visit's time.
    expect(afterSecond.lastVisitAt!.toMillis()).toBeGreaterThanOrEqual(afterFirst.lastVisitAt!.toMillis());
  });

  it("Manual Add Points (no Rule Engine, §11) does NOT count as a visit — activityStats stays untouched", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Somchai" });
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 20,
      reason: "correction",
      idempotencyKey: uniqueId("manual"),
    });
    const stats = await activityStatsOf(membershipId);
    expect(stats.firstVisitAt).toBeNull();
    expect(stats.lastVisitAt).toBeNull();
  });

  it("Reward Redeem then Use (two separate recordVisit call sites, §13) both advance activityStats correctly", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Somchai" });
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 50,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });
    const rewardId = await createRewardTemplate(ownerCtx, { name: "กาแฟฟรี", type: "FREE_PRODUCT", requiredPoints: 50 });

    const { voucherId } = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });
    const afterRedeem = await activityStatsOf(membershipId);
    expect(afterRedeem.firstVisitAt).not.toBeNull();
    const firstVisitMs = afterRedeem.firstVisitAt!.toMillis();

    await confirmVoucherUse(ownerCtx, {
      voucherId,
      branchId: null,
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("use"),
    });
    const afterUse = await activityStatsOf(membershipId);
    expect(afterUse.firstVisitAt!.toMillis()).toBe(firstVisitMs); // still hasn't moved
    expect(afterUse.lastVisitAt!.toMillis()).toBeGreaterThanOrEqual(afterRedeem.lastVisitAt!.toMillis());
  });

  it("Coupon manual issue then redeem (two more recordVisit call sites, §14) both advance activityStats correctly", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Somchai" });
    const couponId = await createCouponTemplate(ownerCtx, { name: "ส่วนลด 50 บาท", type: "FIXED_DISCOUNT" });

    const { code } = await issueCouponManual(ownerCtx, {
      membershipId,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });
    const afterIssue = await activityStatsOf(membershipId);
    expect(afterIssue.firstVisitAt).not.toBeNull();
    const firstVisitMs = afterIssue.firstVisitAt!.toMillis();

    await redeemCoupon(ownerCtx, {
      code,
      branchId: null,
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("redeem"),
    });
    const afterRedeem = await activityStatsOf(membershipId);
    expect(afterRedeem.firstVisitAt!.toMillis()).toBe(firstVisitMs); // still hasn't moved
    expect(afterRedeem.lastVisitAt!.toMillis()).toBeGreaterThanOrEqual(afterIssue.lastVisitAt!.toMillis());
  });
});
