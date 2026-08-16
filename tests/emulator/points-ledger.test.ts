import type { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import {
  addManualPoints,
  adjustPoints,
  earnPointsByRule,
  getPointsHistory,
  reversePoints,
} from "@/modules/points/ledger-service";
import { createPointRule } from "@/modules/points/rule-engine";
import {
  AuthorizationError,
  ConflictError,
  TenantIsolationError,
  ValidationError,
} from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

import { addStaffFixture, createMerchantFixture, uniqueId } from "./setup";

/**
 * Points Ledger + Lots + FIFO + Expiration + Reversal (FINAL-ARCHITECTURE.md §9, §11, §12, §15,
 * §17, §26) against the real Firestore emulator, exercised entirely through the service layer
 * (`src/modules/points/ledger-service.ts`) — the same path the Phase 3 API routes call.
 */

async function membershipBalance(membershipId: string): Promise<number> {
  const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
  return (snap.data() as { pointsBalance: number }).pointsBalance;
}

async function lotsFor(membershipId: string): Promise<Array<Record<string, unknown> & { id: string }>> {
  const snap = await getDb()
    .collection(COLLECTIONS.pointsLots)
    .where("membershipId", "==", membershipId)
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function visitsFor(membershipId: string): Promise<Array<Record<string, unknown>>> {
  const snap = await getDb()
    .collection(COLLECTIONS.visits)
    .where("membershipId", "==", membershipId)
    .get();
  return snap.docs.map((d) => d.data());
}

async function eventsFor(membershipId: string): Promise<Array<Record<string, unknown>>> {
  const snap = await getDb()
    .collection(COLLECTIONS.events)
    .where("membershipId", "==", membershipId)
    .get();
  return snap.docs.map((d) => d.data());
}

/** Creates a merchant + one member + one PER_VISIT BASE rule worth `points` per visit. */
async function setupWithVisitRule(points = 10) {
  const merchant = await createMerchantFixture();
  const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Somchai" });
  await createPointRule(merchant.ownerCtx, {
    name: "เข้าร้าน",
    type: "PER_VISIT",
    config: { pointsPerVisit: points },
  });
  return { ...merchant, membershipId };
}

describe("Points Ledger — earnPointsByRule (§11 stacking + §12 EARN flow)", () => {
  it("credits the rule's points, creates one lot, updates the cached balance, and records a visit", async () => {
    const { ownerCtx, membershipId } = await setupWithVisitRule(10);

    const result = await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });

    expect(result.delta).toBe(10);
    expect(result.appliedRules).toHaveLength(1);
    await expect(membershipBalance(membershipId)).resolves.toBe(10);

    const lots = await lotsFor(membershipId);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ earnedAmount: 10, remainingAmount: 10, status: "ACTIVE" });

    const visits = await visitsFor(membershipId);
    expect(visits).toHaveLength(1);
    expect(visits[0]).toMatchObject({ source: "STAFF_SCAN", countsAsVisit: true });
  });

  it("writes both a points.earned and a visit.recorded event in the same transaction (§17)", async () => {
    const { ownerCtx, membershipId } = await setupWithVisitRule(10);
    await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });

    const events = await eventsFor(membershipId);
    const types = events.map((e) => e.type).sort();
    // `membership.created` (Phase 6) is now also emitted by `createMembership` itself, which
    // `setupWithVisitRule` calls to set up this fixture — included here, not a regression.
    expect(types).toEqual(["membership.created", "points.earned", "visit.recorded"]);
    expect(events.every((e) => e.merchantId && e.schemaVersion === 1)).toBe(true);
  });

  it("a repeated idempotencyKey never double-credits (double-submit / network retry safety, §27)", async () => {
    const { ownerCtx, membershipId } = await setupWithVisitRule(10);
    const idempotencyKey = uniqueId("earn");

    const first = await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey,
    });
    const second = await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey,
    });

    expect(second.ledgerEntryId).toBe(first.ledgerEntryId);
    await expect(membershipBalance(membershipId)).resolves.toBe(10);
    await expect(lotsFor(membershipId)).resolves.toHaveLength(1);
  });

  it("throws when no active rule matches the event (no ledger entry, no balance change)", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "No Rule" });

    await expect(
      earnPointsByRule(merchant.ownerCtx, {
        membershipId,
        branchId: null,
        sourceType: "PER_VISIT",
        visitSource: "STAFF_SCAN",
        idempotencyKey: uniqueId("earn"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(0);
  });
});

describe("Points Ledger — addManualPoints (§9, §11: bypasses the Rule Engine entirely)", () => {
  it("credits exactly the given amount, with no appliedRules and no Visit record", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Manual" });

    const result = await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 50,
      reason: "แต้มพิเศษ",
      idempotencyKey: uniqueId("manual"),
    });

    expect(result.delta).toBe(50);
    expect(result.appliedRules).toEqual([]);
    await expect(membershipBalance(membershipId)).resolves.toBe(50);
    await expect(visitsFor(membershipId)).resolves.toHaveLength(0);
  });

  it("Staff manual add above managerApprovalThreshold is rejected; Manager/Owner can still do it", async () => {
    const merchant = await createMerchantFixture();
    const staff = await addStaffFixture(merchant.ownerCtx, "STAFF");
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Threshold" });

    // Default staffLimits: manualAdjustmentLimit=2000, managerApprovalThreshold=500 — 600 is under
    // the ceiling but over the Staff-role approval bar.
    await expect(
      addManualPoints(staff.ctx, {
        membershipId,
        branchId: null,
        amount: 600,
        reason: "big add",
        idempotencyKey: uniqueId("manual"),
      }),
    ).rejects.toThrow(AuthorizationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(0);

    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 600,
      reason: "big add by owner",
      idempotencyKey: uniqueId("manual"),
    });
    await expect(membershipBalance(membershipId)).resolves.toBe(600);
  });

  it("manualAdjustmentLimit is a hard ceiling for every role, Owner included", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Ceiling" });

    await expect(
      addManualPoints(merchant.ownerCtx, {
        membershipId,
        branchId: null,
        amount: 2500, // over manualAdjustmentLimit (2000)
        reason: "too much",
        idempotencyKey: uniqueId("manual"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(0);
  });
});

describe("Points Ledger — Staff Limits enforced transactionally, not check-then-write (§9, §26)", () => {
  async function setStaffLimits(merchantId: string, overrides: Record<string, number>) {
    await getDb()
      .collection(COLLECTIONS.merchants)
      .doc(merchantId)
      .update(
        Object.fromEntries(Object.entries(overrides).map(([k, v]) => [`staffLimits.${k}`, v])),
      );
  }

  it("maxPointsPerTransaction blocks a single add over the per-transaction cap", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Cap" });
    await setStaffLimits(merchant.merchantId, { maxPointsPerTransaction: 100, manualAdjustmentLimit: 2000 });

    await expect(
      addManualPoints(merchant.ownerCtx, {
        membershipId,
        branchId: null,
        amount: 150,
        reason: "over cap",
        idempotencyKey: uniqueId("manual"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(0);
  });

  it("maxPointsPerHour caps the rolling sum for the same staff+member, computed from ledger reads inside the transaction", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Hourly" });
    await setStaffLimits(merchant.merchantId, {
      maxPointsPerTransaction: 1000,
      manualAdjustmentLimit: 2000,
      maxPointsPerHour: 150,
      maxPointsPerDay: 999999,
    });

    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 100,
      reason: "first",
      idempotencyKey: uniqueId("manual"),
    });
    await expect(
      addManualPoints(merchant.ownerCtx, {
        membershipId,
        branchId: null,
        amount: 100, // 100 + 100 = 200 > 150
        reason: "second",
        idempotencyKey: uniqueId("manual"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(100); // only the first committed
  });

  it("maxPointsPerDay caps the rolling sum independently of the hourly cap", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Daily" });
    await setStaffLimits(merchant.merchantId, {
      maxPointsPerTransaction: 1000,
      manualAdjustmentLimit: 2000,
      maxPointsPerHour: 999999,
      maxPointsPerDay: 150,
    });

    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 100,
      reason: "first",
      idempotencyKey: uniqueId("manual"),
    });
    await expect(
      addManualPoints(merchant.ownerCtx, {
        membershipId,
        branchId: null,
        amount: 100,
        reason: "second",
        idempotencyKey: uniqueId("manual"),
      }),
    ).rejects.toThrow(ValidationError);
    await expect(membershipBalance(membershipId)).resolves.toBe(100);
  });
});

describe("Points Ledger — adjustPoints (Owner/Manager only, §9, §12)", () => {
  it("Staff cannot call adjustPoints at all", async () => {
    const merchant = await createMerchantFixture();
    const staff = await addStaffFixture(merchant.ownerCtx, "STAFF");
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "NoAdjust" });

    await expect(
      adjustPoints(staff.ctx, {
        membershipId,
        delta: 10,
        reason: "test",
        idempotencyKey: uniqueId("adjust"),
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("a positive delta grants points and creates a new lot, like an EARN", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Grant" });

    await adjustPoints(merchant.ownerCtx, {
      membershipId,
      delta: 25,
      reason: "correction",
      idempotencyKey: uniqueId("adjust"),
    });

    await expect(membershipBalance(membershipId)).resolves.toBe(25);
    await expect(lotsFor(membershipId)).resolves.toHaveLength(1);
  });

  it("a negative delta deducts via FIFO and aborts entirely (no partial write) if balance is insufficient", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Deduct" });
    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 10,
      reason: "seed",
      idempotencyKey: uniqueId("manual"),
    });

    await expect(
      adjustPoints(merchant.ownerCtx, {
        membershipId,
        delta: -20, // more than the 10 available
        reason: "too much",
        idempotencyKey: uniqueId("adjust"),
      }),
    ).rejects.toThrow(ValidationError);

    // Whole transaction must abort — balance and lot untouched, not partially decremented.
    await expect(membershipBalance(membershipId)).resolves.toBe(10);
    const lots = await lotsFor(membershipId);
    expect(lots).toHaveLength(1);
    expect(lots[0].remainingAmount).toBe(10);
  });

  it("a valid negative delta deducts exactly that amount via FIFO", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "Deduct2" });
    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 10,
      reason: "seed",
      idempotencyKey: uniqueId("manual"),
    });

    await adjustPoints(merchant.ownerCtx, {
      membershipId,
      delta: -4,
      reason: "correction",
      idempotencyKey: uniqueId("adjust"),
    });

    await expect(membershipBalance(membershipId)).resolves.toBe(6);
    const lots = await lotsFor(membershipId);
    expect(lots[0].remainingAmount).toBe(6);
    expect(lots[0].status).toBe("ACTIVE");
  });
});

describe("Points Ledger — reversePoints (Owner/Manager only, §12 Reversal)", () => {
  async function earnOnce(ctx: AuthContext, membershipId: string, amount: number) {
    return adjustPoints(ctx, {
      membershipId,
      delta: amount,
      reason: "seed earn",
      idempotencyKey: uniqueId("adjust"),
    });
  }

  it("Staff cannot call reversePoints at all", async () => {
    const merchant = await createMerchantFixture();
    const staff = await addStaffFixture(merchant.ownerCtx, "STAFF");
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "NoReverse" });
    const { ledgerEntryId } = await earnOnce(merchant.ownerCtx, membershipId, 10);

    await expect(
      reversePoints(staff.ctx, {
        ledgerEntryId,
        reason: "test",
        idempotencyKey: uniqueId("reverse"),
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("reversing a fully-unspent EARN-equivalent restores the lot to zero and the balance to zero", async () => {
    const { ownerCtx, membershipId } = await setupWithVisitRule(10);
    const earned = await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });

    await reversePoints(ownerCtx, {
      ledgerEntryId: earned.ledgerEntryId,
      reason: "mistake",
      idempotencyKey: uniqueId("reverse"),
    });

    await expect(membershipBalance(membershipId)).resolves.toBe(0);
    const lots = await lotsFor(membershipId);
    expect(lots[0]).toMatchObject({ remainingAmount: 0, status: "DEPLETED" });
  });

  it("the same ledger entry cannot be reversed twice (ConflictError)", async () => {
    const { ownerCtx, membershipId } = await setupWithVisitRule(10);
    const earned = await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });

    await reversePoints(ownerCtx, {
      ledgerEntryId: earned.ledgerEntryId,
      reason: "first reversal",
      idempotencyKey: uniqueId("reverse"),
    });
    await expect(
      reversePoints(ownerCtx, {
        ledgerEntryId: earned.ledgerEntryId,
        reason: "second reversal attempt",
        idempotencyKey: uniqueId("reverse"),
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("a ledger entry type other than EARN/SPEND cannot be reversed (e.g. an ADJUSTMENT)", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "AdjRev" });
    const { ledgerEntryId } = await earnOnce(merchant.ownerCtx, membershipId, 10);

    await expect(
      reversePoints(merchant.ownerCtx, {
        ledgerEntryId,
        reason: "cannot reverse an ADJUSTMENT",
        idempotencyKey: uniqueId("reverse"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("reversing a partially-spent EARN reduces the origin lot to zero, records the shortfall as history, and never touches a different, unrelated lot", async () => {
    const { ownerCtx, membershipId } = await setupWithVisitRule(10);
    const earned = await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });
    // A separate, unrelated lot the member legitimately holds — must be left completely alone by
    // the reversal below, even though it has more than enough balance to "cover" the shortfall.
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 20,
      reason: "unrelated top-up",
      idempotencyKey: uniqueId("manual"),
    });
    // Partially consume the ORIGIN lot specifically (FIFO picks the earliest-expiring/oldest
    // first — with no expiration policy set both lots are non-expiring, so this consumes from the
    // first-created lot, i.e. the one from `earned` above).
    await adjustPoints(ownerCtx, {
      membershipId,
      delta: -6,
      reason: "partial spend of the original lot",
      idempotencyKey: uniqueId("adjust"),
    });
    expect(await membershipBalance(membershipId)).toBe(24); // 10 + 20 - 6

    await reversePoints(ownerCtx, {
      ledgerEntryId: earned.ledgerEntryId,
      reason: "reverse the original mistaken earn",
      idempotencyKey: uniqueId("reverse"),
    });

    // Total balance decrement is the FULL original 10 (4 remaining in the lot + 6 shortfall),
    // taking the member "into debt" relative to what's left in their other, unrelated lot — the
    // documented, intended outcome (never blocked by, and never draining, unrelated balance).
    await expect(membershipBalance(membershipId)).resolves.toBe(14); // 24 - 10

    const lots = await lotsFor(membershipId);
    const originLot = lots.find((l) => l.originLedgerEntryId === earned.ledgerEntryId);
    const otherLot = lots.find((l) => l.originLedgerEntryId !== earned.ledgerEntryId);
    expect(originLot).toMatchObject({ remainingAmount: 0, status: "DEPLETED" });
    // The unrelated lot must be untouched — still its full 20, never drained to pay for the
    // shortfall of a completely different transaction.
    expect(otherLot).toMatchObject({ remainingAmount: 20, status: "ACTIVE" });

    const consumptions = await getDb()
      .collection(COLLECTIONS.pointsLotConsumptions)
      .where("lotId", "==", otherLot!.id)
      .get();
    expect(consumptions.empty).toBe(true);
  });
});

describe("Points Ledger — FIFO consumption order (§12: expires soonest first)", () => {
  it("spends from the soonest-expiring lot before a later-expiring one, even though it was earned second", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await createMembership(merchant.ownerCtx, { displayName: "FIFO" });
    const db = getDb();

    // Earned first, expires LATER.
    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 10,
      reason: "earned first, expires later",
      idempotencyKey: uniqueId("manual"),
    });
    const lotsAfterFirst = await lotsFor(membershipId);
    await db
      .collection(COLLECTIONS.pointsLots)
      .doc(lotsAfterFirst[0].id)
      .update({ expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) });

    // Earned second, expires SOONER — FIFO must prefer this one despite being newer.
    await addManualPoints(merchant.ownerCtx, {
      membershipId,
      branchId: null,
      amount: 10,
      reason: "earned second, expires sooner",
      idempotencyKey: uniqueId("manual"),
    });
    const lotsAfterSecond = await lotsFor(membershipId);
    const secondLot = lotsAfterSecond.find((l) => l.id !== lotsAfterFirst[0].id)!;
    await db
      .collection(COLLECTIONS.pointsLots)
      .doc(secondLot.id)
      .update({ expiresAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) });

    await adjustPoints(merchant.ownerCtx, {
      membershipId,
      delta: -7,
      reason: "spend less than the soonest-expiring lot",
      idempotencyKey: uniqueId("adjust"),
    });

    const finalLots = await lotsFor(membershipId);
    const firstLot = finalLots.find((l) => l.id === lotsAfterFirst[0].id)!;
    const laterSecondLot = finalLots.find((l) => l.id === secondLot.id)!;
    expect(laterSecondLot.remainingAmount).toBe(3); // the sooner-expiring lot took the hit
    expect(firstLot.remainingAmount).toBe(10); // the later-expiring lot is untouched
  });
});

describe("Points Ledger — Tenant isolation across two independently created merchants (§3, §10, §26)", () => {
  it("earn/manual-add/adjust/reverse/history all reject a membership belonging to another merchant", async () => {
    const merchantA = await setupWithVisitRule(10);
    // Merchant B needs its OWN matching PER_VISIT rule too — otherwise `earnPointsByRule` would
    // legitimately reject with "no active rule" (evaluated against merchantB's own pointRules,
    // before the membership is ever loaded) rather than exercising the tenant-isolation check
    // this test is actually about.
    const merchantB = await setupWithVisitRule(10);

    await expect(
      earnPointsByRule(merchantB.ownerCtx, {
        membershipId: merchantA.membershipId,
        branchId: null,
        sourceType: "PER_VISIT",
        visitSource: "STAFF_SCAN",
        idempotencyKey: uniqueId("earn"),
      }),
    ).rejects.toThrow(TenantIsolationError);

    await expect(
      addManualPoints(merchantB.ownerCtx, {
        membershipId: merchantA.membershipId,
        branchId: null,
        amount: 10,
        reason: "cross tenant",
        idempotencyKey: uniqueId("manual"),
      }),
    ).rejects.toThrow(TenantIsolationError);

    await expect(
      adjustPoints(merchantB.ownerCtx, {
        membershipId: merchantA.membershipId,
        delta: 10,
        reason: "cross tenant",
        idempotencyKey: uniqueId("adjust"),
      }),
    ).rejects.toThrow(TenantIsolationError);

    await expect(getPointsHistory(merchantB.ownerCtx, merchantA.membershipId)).rejects.toThrow(
      TenantIsolationError,
    );

    // Merchant A's own owner is unaffected by all the rejected cross-tenant attempts above.
    await expect(membershipBalance(merchantA.membershipId)).resolves.toBe(0);
  });

  it("reversePoints rejects a ledger entry belonging to another merchant", async () => {
    const merchantA = await setupWithVisitRule(10);
    const merchantB = await createMerchantFixture("Merchant B");
    const earned = await earnPointsByRule(merchantA.ownerCtx, {
      membershipId: merchantA.membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });

    await expect(
      reversePoints(merchantB.ownerCtx, {
        ledgerEntryId: earned.ledgerEntryId,
        reason: "cross tenant reverse",
        idempotencyKey: uniqueId("reverse"),
      }),
    ).rejects.toThrow(TenantIsolationError);
  });
});

describe("Points Ledger — getPointsHistory (§12)", () => {
  it("returns this membership's ledger entries only, newest first", async () => {
    const { ownerCtx, membershipId } = await setupWithVisitRule(10);
    await earnPointsByRule(ownerCtx, {
      membershipId,
      branchId: null,
      sourceType: "PER_VISIT",
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("earn"),
    });
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 5,
      reason: "extra",
      idempotencyKey: uniqueId("manual"),
    });

    const history = await getPointsHistory(ownerCtx, membershipId);
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.membershipId === membershipId)).toBe(true);
    const createdAtMillis = (h: (typeof history)[number]) => (h.createdAt as Timestamp).toMillis();
    expect(createdAtMillis(history[0])).toBeGreaterThanOrEqual(createdAtMillis(history[1]));
  });
});
