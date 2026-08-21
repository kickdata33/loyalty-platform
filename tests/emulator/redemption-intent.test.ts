import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";

import { createRewardTemplate, redeemReward, setRewardTemplateEnabled } from "@/modules/reward/service";
import type { CreateRewardTemplateInput } from "@/modules/reward/service";
import {
  confirmRedemptionIntent,
  createRedemptionIntent,
  getRedemptionIntentPreview,
  getRedemptionIntentStatusForCustomer,
} from "@/modules/reward/redemption-intent";
import { addManualPoints } from "@/modules/points/ledger-service";
import { resolveOrCreateLineMembership } from "@/modules/membership/service";
import { NotFoundError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { InMemorySecretStore, setSecretStoreForTesting } from "@/modules/shared/secret-store";
import type { AuthContext } from "@/modules/shared/types";

import { createMerchantFixture, uniqueId } from "./setup";

/**
 * Customer self-service reward redemption (new work) — the redemption-intent lifecycle:
 * create (member) -> preview (staff scan) -> confirm (staff), reusing `redeemReward()` entirely
 * for the actual points/stock/voucher logic. Covers every explicit security requirement: server-
 * authoritative validation, tenant scoping, one-time use, short expiry, never trusting client-
 * supplied rewardId/points/balance, re-checking balance at confirm time, and race-condition safety.
 */
beforeEach(() => {
  setSecretStoreForTesting(new InMemorySecretStore());
});

async function seedLineMember(merchantId: string, points: number, ownerCtx: AuthContext): Promise<string> {
  const membershipId = await resolveOrCreateLineMembership({
    merchantId,
    platformCustomerId: uniqueId("pc"),
    lineUserId: uniqueId("Uline"),
    channelId: uniqueId("channel"),
    displayName: "Redeem Tester",
  });
  if (points > 0) {
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: points,
      reason: "seed points",
      idempotencyKey: uniqueId("seed"),
    });
  }
  return membershipId;
}

async function seedReward(ctx: AuthContext, overrides: Partial<CreateRewardTemplateInput> = {}): Promise<string> {
  return createRewardTemplate(ctx, {
    name: "เครื่องดื่มฟรี",
    type: "FREE_PRODUCT",
    requiredPoints: 20,
    ...overrides,
  });
}

async function voucherCount(merchantId: string, membershipId: string): Promise<number> {
  const snap = await getDb()
    .collection(COLLECTIONS.voucherInstances)
    .where("merchantId", "==", merchantId)
    .where("membershipId", "==", membershipId)
    .get();
  return snap.size;
}

async function membershipBalance(membershipId: string): Promise<number> {
  const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
  return (snap.data() as { pointsBalance: number }).pointsBalance;
}

describe("createRedemptionIntent — server-authoritative validation, never trusts client input", () => {
  it("succeeds and returns a QR when the reward is enabled and the member has enough points", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx);
    const membershipId = await seedLineMember(merchantId, 20, ownerCtx);

    const result = await createRedemptionIntent(merchantId, membershipId, rewardId);

    expect(result.intentId).toBeTruthy();
    expect(result.qrCodeDataUrl.startsWith("data:image/")).toBe(true);
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a disabled reward — re-fetched from Firestore, never trusts a client claim that it's active", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx);
    await setRewardTemplateEnabled(ownerCtx, rewardId, false);
    const membershipId = await seedLineMember(merchantId, 100, ownerCtx);

    await expect(createRedemptionIntent(merchantId, membershipId, rewardId)).rejects.toThrow(ValidationError);
  });

  it("rejects a reward belonging to a different merchant (never leaks that it exists)", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    const rewardIdB = await seedReward(merchantB.ownerCtx);
    const membershipIdA = await seedLineMember(merchantA.merchantId, 100, merchantA.ownerCtx);

    await expect(createRedemptionIntent(merchantA.merchantId, membershipIdA, rewardIdB)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("rejects when the member does not have enough points (pre-check)", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 50 });
    const membershipId = await seedLineMember(merchantId, 10, ownerCtx);

    await expect(createRedemptionIntent(merchantId, membershipId, rewardId)).rejects.toThrow(ValidationError);
  });
});

describe("confirmRedemptionIntent — successful redemption, reusing redeemReward() unchanged", () => {
  it("deducts points, creates exactly one voucher, and marks the intent CONFIRMED with a voucherId", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 20 });
    const membershipId = await seedLineMember(merchantId, 20, ownerCtx);

    const { intentId } = await createRedemptionIntent(merchantId, membershipId, rewardId);

    const preview = await getRedemptionIntentPreview(ownerCtx, intentId);
    expect(preview).toMatchObject({
      memberDisplayName: "Redeem Tester",
      rewardName: "เครื่องดื่มฟรี",
      requiredPoints: 20,
      currentPointsBalance: 20,
      status: "PENDING",
    });

    const result = await confirmRedemptionIntent(ownerCtx, intentId);
    expect(result.voucherId).toBeTruthy();
    expect(result.rewardName).toBe("เครื่องดื่มฟรี");

    await expect(membershipBalance(membershipId)).resolves.toBe(0);
    await expect(voucherCount(merchantId, membershipId)).resolves.toBe(1);

    const statusForCustomer = await getRedemptionIntentStatusForCustomer(merchantId, membershipId, intentId);
    expect(statusForCustomer.status).toBe("CONFIRMED");
  });
});

describe("confirmRedemptionIntent — one-time use / replay protection", () => {
  it("rejects confirming the same intent a second time, without double-deducting points", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 20 });
    const membershipId = await seedLineMember(merchantId, 20, ownerCtx);
    const { intentId } = await createRedemptionIntent(merchantId, membershipId, rewardId);

    await confirmRedemptionIntent(ownerCtx, intentId);
    await expect(confirmRedemptionIntent(ownerCtx, intentId)).rejects.toThrow(ValidationError);

    await expect(membershipBalance(membershipId)).resolves.toBe(0); // not -20
    await expect(voucherCount(merchantId, membershipId)).resolves.toBe(1); // not 2
  });
});

describe("confirmRedemptionIntent — expiry (~5 minutes)", () => {
  it("rejects confirming an intent whose expiresAt has already passed, and flips its status to EXPIRED", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 20 });
    const membershipId = await seedLineMember(merchantId, 20, ownerCtx);
    const { intentId } = await createRedemptionIntent(merchantId, membershipId, rewardId);

    // Simulate time passing (can't wait 5 real minutes) — directly backdate expiresAt, exactly
    // like a real intent would look once its TTL has elapsed.
    await getDb()
      .collection(COLLECTIONS.redemptionIntents)
      .doc(intentId)
      .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });

    await expect(confirmRedemptionIntent(ownerCtx, intentId)).rejects.toThrow(ValidationError);

    const statusForCustomer = await getRedemptionIntentStatusForCustomer(merchantId, membershipId, intentId);
    expect(statusForCustomer.status).toBe("EXPIRED");
    await expect(membershipBalance(membershipId)).resolves.toBe(20); // untouched
    await expect(voucherCount(merchantId, membershipId)).resolves.toBe(0);
  });
});

describe("confirmRedemptionIntent — insufficient points re-checked at confirmation time", () => {
  it("fails and marks the intent FAILED when the balance drops below requiredPoints between intent creation and confirmation", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 20 }); // no limitPerMember
    const membershipId = await seedLineMember(merchantId, 20, ownerCtx);
    const { intentId } = await createRedemptionIntent(merchantId, membershipId, rewardId);

    // Balance changes in the interim (e.g. staff redeems the same reward again for this member
    // directly) — the intent was created when 20 points was enough; it no longer is.
    await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("drain"),
    });
    await expect(membershipBalance(membershipId)).resolves.toBe(0);

    await expect(confirmRedemptionIntent(ownerCtx, intentId)).rejects.toThrow();

    const statusForCustomer = await getRedemptionIntentStatusForCustomer(merchantId, membershipId, intentId);
    expect(statusForCustomer.status).toBe("FAILED");
    await expect(voucherCount(merchantId, membershipId)).resolves.toBe(1); // only the direct redeem above
  });
});

describe("confirmRedemptionIntent — concurrent confirmation (race safety)", () => {
  it("only one of two simultaneous confirm attempts succeeds; the reward is redeemed exactly once", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 20 });
    const membershipId = await seedLineMember(merchantId, 20, ownerCtx);
    const { intentId } = await createRedemptionIntent(merchantId, membershipId, rewardId);

    const results = await Promise.allSettled([
      confirmRedemptionIntent(ownerCtx, intentId),
      confirmRedemptionIntent(ownerCtx, intentId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    await expect(membershipBalance(membershipId)).resolves.toBe(0); // deducted exactly once
    await expect(voucherCount(merchantId, membershipId)).resolves.toBe(1); // exactly one voucher
  });
});

describe("redemption intents — tenant isolation", () => {
  it("staff of a different merchant cannot preview or confirm another merchant's intent", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    const rewardIdA = await seedReward(merchantA.ownerCtx);
    const membershipIdA = await seedLineMember(merchantA.merchantId, 20, merchantA.ownerCtx);
    const { intentId } = await createRedemptionIntent(merchantA.merchantId, membershipIdA, rewardIdA);

    await expect(getRedemptionIntentPreview(merchantB.ownerCtx, intentId)).rejects.toThrow(NotFoundError);
    await expect(confirmRedemptionIntent(merchantB.ownerCtx, intentId)).rejects.toThrow(NotFoundError);

    // Merchant A's own staff can still use it normally — proves the rejection above was really
    // about tenant scoping, not something wrong with the intent itself.
    const result = await confirmRedemptionIntent(merchantA.ownerCtx, intentId);
    expect(result.voucherId).toBeTruthy();
  });

  it("a customer cannot poll the status of another member's intent, even within the same merchant", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx);
    const membershipA = await seedLineMember(merchantId, 20, ownerCtx);
    const membershipB = await seedLineMember(merchantId, 20, ownerCtx);
    const { intentId } = await createRedemptionIntent(merchantId, membershipA, rewardId);

    await expect(getRedemptionIntentStatusForCustomer(merchantId, membershipB, intentId)).rejects.toThrow(
      NotFoundError,
    );
    // The rightful owner can still poll it.
    await expect(getRedemptionIntentStatusForCustomer(merchantId, membershipA, intentId)).resolves.toMatchObject({
      status: "PENDING",
    });
  });

});

describe("redemption intents — cross-tenant membership guard on intent creation", () => {
  it("throws TenantIsolationError if the membership somehow doesn't belong to the given merchant", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    const rewardIdB = await seedReward(merchantB.ownerCtx);
    const membershipIdA = await seedLineMember(merchantA.merchantId, 100, merchantA.ownerCtx);

    await expect(createRedemptionIntent(merchantB.merchantId, membershipIdA, rewardIdB)).rejects.toThrow(
      TenantIsolationError,
    );
  });
});
