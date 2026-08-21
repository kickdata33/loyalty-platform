import { describe, expect, it } from "vitest";

import { getCustomerPortalView } from "@/modules/customer-portal/service";
import { createRewardTemplate, redeemReward } from "@/modules/reward/service";
import { createCouponTemplate, issueCouponManual } from "@/modules/coupon/service";
import { addManualPoints } from "@/modules/points/ledger-service";
import { resolveOrCreateLineMembership } from "@/modules/membership/service";

import { createMerchantFixture, uniqueId } from "./setup";

/**
 * Customer Portal member view (new work, approved beyond Phase 7's original DoD) — reuses the
 * exact same service functions/queries the staff-facing dashboard already uses
 * (`listVoucherInstancesForMembership`/`listCouponInstancesForMembership`/
 * `listPointsLedgerForMembership`, `generateMemberQrCodeDataUrl`), scoped entirely by
 * `(merchantId, platformCustomerId)` resolved from the customer's own verified identity — never a
 * client-supplied `membershipId`.
 */

async function seedLineMembership(merchantId: string, platformCustomerId: string, displayName: string) {
  return resolveOrCreateLineMembership({
    merchantId,
    platformCustomerId,
    lineUserId: uniqueId("Uline"),
    channelId: uniqueId("channel"),
    displayName,
  });
}

describe("getCustomerPortalView()", () => {
  it("returns null when this identity has no membership for this merchant yet", async () => {
    const merchant = await createMerchantFixture();
    const view = await getCustomerPortalView(merchant.merchantId, uniqueId("pc"));
    expect(view).toBeNull();
  });

  it("returns the member card fields — displayName, memberCode, pointsBalance, a QR data URL, joinedAt", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    await seedLineMembership(merchant.merchantId, platformCustomerId, "คุณทดสอบ");

    const view = await getCustomerPortalView(merchant.merchantId, platformCustomerId);

    expect(view?.displayName).toBe("คุณทดสอบ");
    expect(view?.memberCode).toBeTruthy();
    expect(view?.pointsBalance).toBe(0);
    expect(view?.qrCodeDataUrl.startsWith("data:image/")).toBe(true);
    expect(view?.joinedAt).toBeTruthy();
    expect(view?.rewards).toEqual([]);
    expect(view?.coupons).toEqual([]);
  });

  it("shows a redeemed reward (rewards[]), reusing the exact same redeemReward()/voucherInstances the staff dashboard uses", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    const membershipId = await seedLineMembership(merchant.merchantId, platformCustomerId, "Reward Member");

    const rewardId = await createRewardTemplate(merchant.ownerCtx, {
      name: "เครื่องดื่มฟรี",
      type: "FREE_PRODUCT",
      requiredPoints: 20,
    });
    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 20,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });
    await redeemReward(merchant.ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });

    const view = await getCustomerPortalView(merchant.merchantId, platformCustomerId);

    expect(view?.rewards).toHaveLength(1);
    expect(view?.rewards[0]).toMatchObject({ rewardName: "เครื่องดื่มฟรี", status: "AVAILABLE" });
    expect(view?.pointsBalance).toBe(0); // 20 earned, 20 spent
  });

  it("shows an issued coupon (coupons[]), reusing issueCouponManual()/couponInstances", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    const membershipId = await seedLineMembership(merchant.merchantId, platformCustomerId, "Coupon Member");

    const couponId = await createCouponTemplate(merchant.ownerCtx, {
      name: "ส่วนลด 20 บาท",
      type: "FIXED_DISCOUNT",
    });
    await issueCouponManual(merchant.ownerCtx, {
      membershipId,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });

    const view = await getCustomerPortalView(merchant.merchantId, platformCustomerId);

    expect(view?.coupons).toHaveLength(1);
    expect(view?.coupons[0]).toMatchObject({ couponName: "ส่วนลด 20 บาท", status: "AVAILABLE" });
  });

  it("shows recent points history, reusing addManualPoints()/pointsLedger", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    const membershipId = await seedLineMembership(merchant.merchantId, platformCustomerId, "History Member");

    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 15,
      reason: "welcome bonus",
      idempotencyKey: uniqueId("seed"),
    });

    const view = await getCustomerPortalView(merchant.merchantId, platformCustomerId);

    expect(view?.pointsHistory.length).toBeGreaterThanOrEqual(1);
    expect(view?.pointsHistory[0]).toMatchObject({ delta: 15, reason: "welcome bonus" });
  });

  it("never exposes platformCustomerId, merchantLineIdentity/lineUserId, membershipId, or merchantId", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    await seedLineMembership(merchant.merchantId, platformCustomerId, "Sanitize Check");

    const view = await getCustomerPortalView(merchant.merchantId, platformCustomerId);
    const raw = JSON.stringify(view);

    expect(raw).not.toContain("platformCustomerId");
    expect(raw).not.toContain("merchantLineIdentity");
    expect(raw).not.toContain("lineUserId");
    expect(raw).not.toContain("membershipId");
    expect(raw).not.toContain(merchant.merchantId);
  });

  it("tenant isolation: the same platformCustomerId linked to two different merchants only ever returns that merchant's own membership", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    // A cross-merchant customer identity is a real, supported scenario (§6 opt-in linking aside,
    // the SAME platformCustomerId can independently exist as a member of two different merchants).
    const platformCustomerId = uniqueId("pc");
    await seedLineMembership(merchantA.merchantId, platformCustomerId, "Member At A");
    await seedLineMembership(merchantB.merchantId, platformCustomerId, "Member At B");

    const viewA = await getCustomerPortalView(merchantA.merchantId, platformCustomerId);
    const viewB = await getCustomerPortalView(merchantB.merchantId, platformCustomerId);

    expect(viewA?.displayName).toBe("Member At A");
    expect(viewB?.displayName).toBe("Member At B");
  });
});
