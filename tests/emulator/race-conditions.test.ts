import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import { createMerchantWithOwner } from "@/modules/merchant/service";
import { addManualPoints, adjustPoints } from "@/modules/points/ledger-service";
import { ConflictError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { createStaffUser } from "@/modules/staff/service";

import { createMerchantFixture, createTestAuthUser, uniqueId, uniqueSlug } from "./setup";

/**
 * Concurrency-safety tests found and fixed during the Phase 1 security review: both uniqueness
 * checks below originally ran as a plain query *before* the write (classic TOCTOU) and have been
 * moved to run as a `tx.get(query)` *inside* the same Firestore transaction that performs the
 * write — Firestore includes queries read inside a transaction in its optimistic-concurrency
 * conflict detection, so the loser of a race is retried and observes the winner's document.
 */
describe("Race conditions — uniqueness checks are transaction-safe (emulator)", () => {
  it("createMerchantWithOwner: only one of two concurrent signups with the same slug succeeds", async () => {
    const slug = uniqueSlug("race-merchant");
    const ownerAuthUidA = await createTestAuthUser("race-owner-a");
    const ownerAuthUidB = await createTestAuthUser("race-owner-b");

    const results = await Promise.allSettled([
      createMerchantWithOwner({
        name: "Race A",
        slug,
        businessType: "cafe",
        timezone: "Asia/Bangkok",
        ownerAuthUid: ownerAuthUidA,
      }),
      createMerchantWithOwner({
        name: "Race B",
        slug,
        businessType: "cafe",
        timezone: "Asia/Bangkok",
        ownerAuthUid: ownerAuthUidB,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
  });

  it("createStaffUser: only one of two concurrent calls for the same authUid+merchant succeeds", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const authUid = await createTestAuthUser("race-staff");

    const results = await Promise.allSettled([
      createStaffUser(ownerCtx, { authUid, role: "STAFF" }),
      createStaffUser(ownerCtx, { authUid, role: "STAFF" }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ValidationError);
  });
});

/**
 * Points Ledger concurrency safety (FINAL-ARCHITECTURE.md §9, §12, §26, §27 — "staff ยิง request
 * ขนานเกิน limit" / "double-submit บน Add Points ต้องไม่เกิดผลซ้ำ" are both named explicitly in the
 * Testing Requirements). Firestore transactions give serializable isolation on the documents they
 * actually read/write (§12 "Concurrency Safety") — two concurrent operations against the same
 * membership contend on the same `pointsLots`/`membership` documents (and, for staff limits, the
 * same `pointsLedger` window query), so the loser retries and observes the winner's write rather
 * than racing past it.
 */
describe("Points Ledger — concurrency safety (emulator)", () => {
  it("two concurrent earnPointsByRule calls with the SAME idempotencyKey never double-credit", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Race Earn" });
    const idempotencyKey = uniqueId("race-earn");

    const results = await Promise.allSettled([
      addManualPoints(ownerCtx, {
        membershipId,
        branchId: null,
        amount: 10,
        reason: "race",
        idempotencyKey,
      }),
      addManualPoints(ownerCtx, {
        membershipId,
        branchId: null,
        amount: 10,
        reason: "race",
        idempotencyKey,
      }),
    ]);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const ledgerEntryIds = new Set(
      results.map((r) => (r as PromiseFulfilledResult<{ ledgerEntryId: string }>).value.ledgerEntryId),
    );
    expect(ledgerEntryIds.size).toBe(1); // both calls resolved to the SAME entry, not two

    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(10); // not 20
  });

  it("two concurrent manual adds that together would exceed maxPointsPerHour never both succeed", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Race Limit" });
    await getDb()
      .collection(COLLECTIONS.merchants)
      .doc(merchantId)
      .update({ "staffLimits.maxPointsPerHour": 100, "staffLimits.manualAdjustmentLimit": 2000 });

    const results = await Promise.allSettled([
      addManualPoints(ownerCtx, {
        membershipId,
        branchId: null,
        amount: 80,
        reason: "race A",
        idempotencyKey: uniqueId("race-limit"),
      }),
      addManualPoints(ownerCtx, {
        membershipId,
        branchId: null,
        amount: 80,
        reason: "race B",
        idempotencyKey: uniqueId("race-limit"),
      }),
    ]);

    // 80 + 80 = 160 > 100 — both cannot succeed; the staff-limit check reads the ledger window
    // INSIDE the same transaction as the write (never check-then-write), so the loser's retry
    // observes the winner's entry and correctly re-evaluates against the now-current sum.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);

    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(80); // never 160
  });

  it("two concurrent negative adjustPoints spending the same limited balance never both succeed (no double-spend)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Race Spend" });
    await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 10,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });

    const results = await Promise.allSettled([
      adjustPoints(ownerCtx, {
        membershipId,
        delta: -7,
        reason: "race spend A",
        idempotencyKey: uniqueId("race-spend"),
      }),
      adjustPoints(ownerCtx, {
        membershipId,
        delta: -7,
        reason: "race spend B",
        idempotencyKey: uniqueId("race-spend"),
      }),
    ]);

    // Only 10 points exist; two concurrent -7s (14 total) can never both succeed.
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled.length).toBe(1);

    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    const balance = (snap.data() as { pointsBalance: number }).pointsBalance;
    expect(balance).toBe(3); // 10 - 7, never negative
  });
});
