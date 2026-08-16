import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import { addManualPoints, reversePoints } from "@/modules/points/ledger-service";
import {
  confirmVoucherUse,
  createRewardTemplate,
  getRewardHistory,
  redeemReward,
  setRewardTemplateEnabled,
} from "@/modules/reward/service";
import type { CreateRewardTemplateInput } from "@/modules/reward/service";
import {
  ConflictError,
  NotFoundError,
  TenantIsolationError,
  ValidationError,
} from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

import { addStaffFixture, createMerchantFixture, uniqueId } from "./setup";

/**
 * Redeem/Use flow (FINAL-ARCHITECTURE.md §12, §13) — the transactional core of Phase 4, covering:
 * RBAC, tenant isolation/IDOR, atomicity (insufficient-balance abort, no partial write), stock/
 * limitPerMember/branchScope/dateRange validation, idempotency, and the two locked Planning Review
 * decisions (reversed-source rejection at Use time, lazy expiry at Use time) — including, for the
 * first time anywhere in this codebase, real coverage of `reversePoints`'s SPEND-reversal branch
 * (§12), which existed since Phase 3 but had never been exercised against a genuine SPEND entry.
 */

async function membershipBalance(membershipId: string): Promise<number> {
  const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
  return (snap.data() as { pointsBalance: number }).pointsBalance;
}

async function templateStock(rewardId: string): Promise<number | null> {
  const snap = await getDb().collection(COLLECTIONS.rewardTemplates).doc(rewardId).get();
  return (snap.data() as { stock: number | null }).stock;
}

async function seedMembershipWithPoints(ctx: AuthContext, points: number): Promise<string> {
  const membershipId = await createMembership(ctx, { displayName: "Reward Tester" });
  if (points > 0) {
    await addManualPoints(ctx, {
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
    name: "กาแฟฟรี",
    type: "FREE_PRODUCT",
    requiredPoints: 50,
    ...overrides,
  });
}

describe("redeemReward — atomicity, validation, RBAC, tenant isolation (§12, §13)", () => {
  it("Owner, Manager, AND Staff can all redeem — REWARD_REDEEM is held by every role", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const rewardId = await seedReward(ownerCtx);

    for (const ctx of [ownerCtx, manager.ctx, staff.ctx]) {
      const membershipId = await seedMembershipWithPoints(ownerCtx, 50);
      const result = await redeemReward(ctx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      });
      expect(result.voucherId).toBeTruthy();
    }
  });

  it("spends exactly requiredPoints via FIFO, creates an AVAILABLE voucher, and decrements finite stock", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 50, stock: 3 });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 100);

    const result = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });

    await expect(membershipBalance(membershipId)).resolves.toBe(50);
    await expect(templateStock(rewardId)).resolves.toBe(2);

    const voucherSnap = await getDb().collection(COLLECTIONS.voucherInstances).doc(result.voucherId).get();
    expect(voucherSnap.data()).toMatchObject({ status: "AVAILABLE", membershipId, rewardTemplateId: rewardId });

    const ledgerSnap = await getDb()
      .collection(COLLECTIONS.pointsLedger)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("membershipId", "==", membershipId)
      .where("type", "==", "SPEND")
      .get();
    expect(ledgerSnap.docs).toHaveLength(1);
    expect(ledgerSnap.docs[0].data()).toMatchObject({ delta: -50, sourceType: "REWARD_REDEMPTION" });
  });

  it("unlimited stock (null) is never decremented", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { stock: null });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });
    await expect(templateStock(rewardId)).resolves.toBeNull();
  });

  it("writes a reward.redeemed event, a Visit with relatedRefs.voucherInstanceId, and a reward.redeemed audit log entry", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx);
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    const result = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("redeem"),
    });

    const eventsSnap = await getDb()
      .collection(COLLECTIONS.events)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("type", "==", "reward.redeemed")
      .get();
    expect(eventsSnap.docs).toHaveLength(1);
    expect(eventsSnap.docs[0].data().payload).toMatchObject({ voucherId: result.voucherId });

    const visitsSnap = await getDb()
      .collection(COLLECTIONS.visits)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("membershipId", "==", membershipId)
      .get();
    expect(visitsSnap.docs).toHaveLength(1);
    expect(visitsSnap.docs[0].data()).toMatchObject({
      source: "STAFF_SCAN",
      relatedRefs: { voucherInstanceId: result.voucherId },
    });

    const auditSnap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("action", "==", "reward.redeemed")
      .get();
    expect(auditSnap.docs).toHaveLength(1);
    expect(auditSnap.docs[0].data()).toMatchObject({ targetId: result.voucherId, actorId: ownerCtx.authUid });
  });

  it("insufficient balance aborts the WHOLE transaction — no partial write (balance/stock/voucher all untouched)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 100, stock: 5 });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 10); // not enough

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);

    await expect(membershipBalance(membershipId)).resolves.toBe(10);
    await expect(templateStock(rewardId)).resolves.toBe(5);
    const voucherSnap = await getDb()
      .collection(COLLECTIONS.voucherInstances)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("membershipId", "==", membershipId)
      .get();
    expect(voucherSnap.empty).toBe(true);
  });

  it("a disabled reward cannot be redeemed", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx);
    await setRewardTemplateEnabled(ownerCtx, rewardId, false);
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("out-of-stock (0) cannot be redeemed", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { stock: 0 });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("branchScope restricts redemption to allowed branches; empty branchScope allows all", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const scopedReward = await seedReward(ownerCtx, { branchScope: [branchId] });
    const universalReward = await seedReward(ownerCtx, { branchScope: [] });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 200);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: scopedReward,
        branchId: "some-other-branch",
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: universalReward,
        branchId: "some-other-branch",
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).resolves.toMatchObject({ voucherId: expect.any(String) });
  });

  it("limitPerMember blocks redemption beyond the configured count", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 10, limitPerMember: 1 });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 100);

    await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("a repeated idempotencyKey never double-spends (double-submit safety, §27)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 50 });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);
    const idempotencyKey = uniqueId("redeem");

    const first = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey,
    });
    const second = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey,
    });

    expect(second.voucherId).toBe(first.voucherId);
    await expect(membershipBalance(membershipId)).resolves.toBe(0);
    const vouchersSnap = await getDb()
      .collection(COLLECTIONS.voucherInstances)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("membershipId", "==", membershipId)
      .get();
    expect(vouchersSnap.docs).toHaveLength(1);
  });

  it("throws NotFoundError for a non-existent reward", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);
    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: "does-not-exist",
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("tenant isolation: cross-merchant membershipId and cross-merchant rewardTemplateId are both rejected", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const rewardA = await seedReward(merchantA.ownerCtx);
    const rewardB = await seedReward(merchantB.ownerCtx);
    const membershipA = await seedMembershipWithPoints(merchantA.ownerCtx, 100);

    await expect(
      redeemReward(merchantB.ownerCtx, {
        membershipId: membershipA,
        rewardTemplateId: rewardB,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(TenantIsolationError);

    const membershipB = await seedMembershipWithPoints(merchantB.ownerCtx, 100);
    await expect(
      redeemReward(merchantB.ownerCtx, {
        membershipId: membershipB,
        rewardTemplateId: rewardA,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(TenantIsolationError);
  });
});

describe("confirmVoucherUse — RBAC, tenant isolation, lazy expiry, reversed-source rejection (§12, §13)", () => {
  async function redeemOnce(ctx: AuthContext, requiredPoints = 50) {
    const rewardId = await seedReward(ctx, { requiredPoints });
    const membershipId = await seedMembershipWithPoints(ctx, requiredPoints);
    const { voucherId } = await redeemReward(ctx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });
    return { rewardId, membershipId, voucherId };
  }

  it("Owner, Manager, AND Staff can all confirm use", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");

    for (const ctx of [ownerCtx, manager.ctx, staff.ctx]) {
      const { voucherId } = await redeemOnce(ownerCtx);
      const result = await confirmVoucherUse(ctx, {
        voucherId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("use"),
      });
      expect(result.voucherId).toBe(voucherId);
    }
  });

  it("transitions AVAILABLE -> USED, records usedAt/usedByStaffId/usedBranchId, writes reward.used event + Visit + audit log", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const { voucherId, membershipId } = await redeemOnce(ownerCtx);

    await confirmVoucherUse(ownerCtx, {
      voucherId,
      branchId,
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("use"),
    });

    const voucherSnap = await getDb().collection(COLLECTIONS.voucherInstances).doc(voucherId).get();
    expect(voucherSnap.data()).toMatchObject({
      status: "USED",
      usedByStaffId: ownerCtx.authUid,
      usedBranchId: branchId,
    });
    expect(voucherSnap.data()?.usedAt).toBeTruthy();

    const eventsSnap = await getDb()
      .collection(COLLECTIONS.events)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("type", "==", "reward.used")
      .get();
    expect(eventsSnap.docs).toHaveLength(1);

    const visitsSnap = await getDb()
      .collection(COLLECTIONS.visits)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("membershipId", "==", membershipId)
      .get();
    // one Visit from redeem, one from use
    expect(visitsSnap.docs).toHaveLength(2);
    expect(visitsSnap.docs.some((d) => d.data().relatedRefs?.voucherInstanceId === voucherId)).toBe(true);

    const auditSnap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("action", "==", "reward.used")
      .get();
    expect(auditSnap.docs).toHaveLength(1);
  });

  it("an already-used voucher cannot be used again (ConflictError)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { voucherId } = await redeemOnce(ownerCtx);

    await confirmVoucherUse(ownerCtx, {
      voucherId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("use"),
    });
    await expect(
      confirmVoucherUse(ownerCtx, {
        voucherId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("use"), // different key — this must still be blocked by voucher status
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("a repeated idempotencyKey on Use never double-processes (double-submit safety)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { voucherId } = await redeemOnce(ownerCtx);
    const idempotencyKey = uniqueId("use");

    const first = await confirmVoucherUse(ownerCtx, {
      voucherId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey,
    });
    const second = await confirmVoucherUse(ownerCtx, {
      voucherId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey,
    });
    expect(second.voucherId).toBe(first.voucherId);
  });

  it("lazy expiry: a voucher past its expiresAt is rejected at Use time (§13, locked Planning Review decision — no scheduled sweep)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { voucherId } = await redeemOnce(ownerCtx);
    await getDb()
      .collection(COLLECTIONS.voucherInstances)
      .doc(voucherId)
      .update({ expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });

    await expect(
      confirmVoucherUse(ownerCtx, {
        voucherId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("use"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("reversed-source rejection: reversing the SPEND entry that paid for a voucher blocks its Use, with NO changes to points/ledger-service.ts's `reversePoints` — pure reward-side read (locked Planning Review decision)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { requiredPoints: 50 });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);
    const { voucherId } = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });

    const voucherSnap = await getDb().collection(COLLECTIONS.voucherInstances).doc(voucherId).get();
    const sourceLedgerEntryId = voucherSnap.data()?.sourceLedgerEntryId as string;
    expect(sourceLedgerEntryId).toBeTruthy();

    // This is the FIRST time in this codebase's history that `reversePoints` is exercised against
    // a real SPEND-type ledger entry — the branch existed since Phase 3 but was never covered.
    await reversePoints(ownerCtx, {
      ledgerEntryId: sourceLedgerEntryId,
      reason: "mistaken redemption",
      idempotencyKey: uniqueId("reverse"),
    });
    // Reversing a SPEND creates a brand-new lot for the refunded amount (§12) — balance goes back up.
    await expect(membershipBalance(membershipId)).resolves.toBe(50);

    await expect(
      confirmVoucherUse(ownerCtx, {
        voucherId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("use"),
      }),
    ).rejects.toThrow(ValidationError);

    // The voucher's own status is untouched by the reversal (still AVAILABLE) — rejection happens
    // purely via the Use-time read of `reversedBy`, confirming no reverse-direction coupling exists.
    const stillAvailable = await getDb().collection(COLLECTIONS.voucherInstances).doc(voucherId).get();
    expect(stillAvailable.data()?.status).toBe("AVAILABLE");
  });

  it("tenant isolation: a voucher belonging to another merchant cannot be used", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const { voucherId } = await redeemOnce(merchantA.ownerCtx);

    await expect(
      confirmVoucherUse(merchantB.ownerCtx, {
        voucherId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("use"),
      }),
    ).rejects.toThrow(TenantIsolationError);
  });

  it("throws NotFoundError for a non-existent voucher", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      confirmVoucherUse(ownerCtx, {
        voucherId: "does-not-exist",
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("use"),
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe("getRewardHistory (§33)", () => {
  it("returns this membership's vouchers only, newest first, and enforces tenant isolation", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const rewardIdA = await seedReward(merchantA.ownerCtx, { requiredPoints: 10 });
    const membershipA = await seedMembershipWithPoints(merchantA.ownerCtx, 30);

    await redeemReward(merchantA.ownerCtx, {
      membershipId: membershipA,
      rewardTemplateId: rewardIdA,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });
    await redeemReward(merchantA.ownerCtx, {
      membershipId: membershipA,
      rewardTemplateId: rewardIdA,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });

    const history = await getRewardHistory(merchantA.ownerCtx, membershipA);
    expect(history).toHaveLength(2);
    expect(history.every((v) => v.membershipId === membershipA)).toBe(true);

    await expect(getRewardHistory(merchantB.ownerCtx, membershipA)).rejects.toThrow(TenantIsolationError);
  });
});

/**
 * §13 "Start/End Date" and "Voucher Expiration" — closes the Final Review BLOCKER by covering
 * the redeem-time enforcement of `assertRewardIsRedeemable`'s date window and the computation of
 * `voucherExpiryRule` into a real `voucherInstance.expiresAt`, neither of which had any test
 * coverage before (the fields were also unreachable via the API/UI at all until this fix).
 */
describe("redeemReward — Start/End Date eligibility window (§13)", () => {
  it("a not-yet-active reward (startAt in the future) cannot be redeemed", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, {
      startAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(50); // untouched
  });

  it("an expired reward (endAt in the past) cannot be redeemed", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, {
      endAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(50); // untouched
  });

  it("a reward currently within its active window (startAt in the past, endAt in the future) CAN be redeemed", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, {
      startAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).resolves.toMatchObject({ voucherId: expect.any(String) });
  });
});

describe("redeemReward — Voucher Expiration behavior (§13)", () => {
  it("voucherExpiryRule=NEVER produces a voucher with expiresAt=null", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { voucherExpiryRule: { type: "NEVER" } });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    const { voucherId } = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });
    const voucherSnap = await getDb().collection(COLLECTIONS.voucherInstances).doc(voucherId).get();
    expect(voucherSnap.data()?.expiresAt).toBeNull();
  });

  it("voucherExpiryRule=DAYS_AFTER_REDEMPTION computes expiresAt correctly from redeemedAt", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, {
      voucherExpiryRule: { type: "DAYS_AFTER_REDEMPTION", days: 7 },
    });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    const before = Date.now();
    const { voucherId } = await redeemReward(ownerCtx, {
      membershipId,
      rewardTemplateId: rewardId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("redeem"),
    });
    const after = Date.now();

    const voucherSnap = await getDb().collection(COLLECTIONS.voucherInstances).doc(voucherId).get();
    const expiresAtMs = (voucherSnap.data()?.expiresAt as { toMillis: () => number }).toMillis();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiresAtMs).toBeLessThanOrEqual(after + sevenDaysMs);
  });
});

describe("redeemReward — Allowed Branches at redeem time, including forged/cross-tenant branch id attempts (§13, §26)", () => {
  it("a real branch id NOT in the reward's branchScope is rejected", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { branchScope: [branchId] });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: "forged-or-unrelated-branch-id",
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("a cross-tenant branch id (real branch of ANOTHER merchant) is also just rejected as not-in-scope — no cross-tenant data is touched or leaked", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const rewardId = await seedReward(merchantA.ownerCtx, { branchScope: [merchantA.branchId] });
    const membershipId = await seedMembershipWithPoints(merchantA.ownerCtx, 50);

    await expect(
      redeemReward(merchantA.ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: merchantB.branchId, // a real id, but belongs to a different merchant entirely
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(50); // untouched
  });

  it("the reward's own allowed branch succeeds", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const rewardId = await seedReward(ownerCtx, { branchScope: [branchId] });
    const membershipId = await seedMembershipWithPoints(ownerCtx, 50);

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).resolves.toMatchObject({ voucherId: expect.any(String) });
  });
});
