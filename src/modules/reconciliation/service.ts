import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

/**
 * Balance Reconciliation (Safety Net) — FINAL-ARCHITECTURE.md §12, §38.4 (Phase 10, gap fix —
 * implements §12 exactly as already specified, not a new decision). §12 states "ต้องมี" (must
 * have) a nightly job comparing `Σ pointsLots.remainingAmount (status=ACTIVE)` against
 * `membership.pointsBalance` per membership — this was never implemented in Phase 1–9.
 *
 * Strictly read-only — never mutates `pointsLots`/`pointsLedger`/`membership.pointsBalance`
 * itself. §12's Reversal pattern requires a human-reviewed correction, not a silent automated
 * write; this module only detects and reports.
 */

export interface BalanceMismatch {
  membershipId: string;
  /** `membership.pointsBalance` — the cache. */
  cachedBalance: number;
  /** `Σ pointsLots.remainingAmount` where `status === 'ACTIVE'` — the source of truth. */
  computedBalance: number;
}

/** Finds every membership of `merchantId` whose cached `pointsBalance` disagrees with the sum of
 * its own active lots. Per-membership queries (not a single cross-membership aggregate) — same
 * "simple over prematurely optimized" choice already made throughout this codebase (§0), and
 * consistent with `dailyAutomationBatch`'s own per-membership loop shape. Equality-only filters
 * (`merchantId`, `membershipId`, `status`) need no new composite index — Firestore serves
 * multi-field equality queries from automatic single-field indexes. */
export async function findBalanceMismatchesForMerchant(merchantId: string): Promise<BalanceMismatch[]> {
  const db = getDb();
  const membershipsSnap = await db
    .collection(COLLECTIONS.memberships)
    .where("merchantId", "==", merchantId)
    .get();

  const mismatches: BalanceMismatch[] = [];
  for (const membershipDoc of membershipsSnap.docs) {
    const cachedBalance = (membershipDoc.data() as { pointsBalance: number }).pointsBalance;
    const lotsSnap = await db
      .collection(COLLECTIONS.pointsLots)
      .where("merchantId", "==", merchantId)
      .where("membershipId", "==", membershipDoc.id)
      .where("status", "==", "ACTIVE")
      .get();
    const computedBalance = lotsSnap.docs.reduce(
      (sum, lotDoc) => sum + ((lotDoc.data() as { remainingAmount: number }).remainingAmount ?? 0),
      0,
    );
    if (computedBalance !== cachedBalance) {
      mismatches.push({ membershipId: membershipDoc.id, cachedBalance, computedBalance });
    }
  }
  return mismatches;
}
