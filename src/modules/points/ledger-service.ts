import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";

import { assertPointsEngineNotFrozenTx } from "@/modules/emergency-control/service";
import { writeEvent } from "@/modules/event/service";
import { loadMembershipForMerchantTx } from "@/modules/membership/service";
import { evaluatePointRules } from "@/modules/points/rule-engine";
import type { AppliedRule, PointRule, PointsLedgerEntryType } from "@/modules/points/types";
import { requireBranchScope, requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { MerchantRecord, PointsExpirationPolicy, StaffLimits } from "@/modules/merchant/types";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  TenantIsolationError,
  ValidationError,
} from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { checkIdempotencyKey, recordIdempotencyKey } from "@/modules/shared/idempotency";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Points Ledger + Lots + FIFO + Expiration + Reversal (FINAL-ARCHITECTURE.md §12) — the
 * transactional core of Phase 3, extended in Phase 4 to be reused by `reward/service.ts` for the
 * points side of a Reward Redemption (§13).
 *
 * Invariants held throughout this file (all enforced *inside* a single Firestore transaction per
 * operation — never check-then-write, per §9/§26):
 * - `pointsLedger` is append-only history; `pointsLots.remainingAmount` is the only mutable field
 *   anywhere in this domain.
 * - `membership.pointsBalance` is a cache — always written atomically alongside the ledger entry
 *   that changes it, via `FieldValue.increment`.
 * - Idempotency key checked/recorded inside the same transaction as the business write.
 * - Staff limits (maxPointsPerTransaction/Hour/Day, manualAdjustmentLimit,
 *   managerApprovalThreshold) checked inside the same transaction as the ledger write.
 * - No hard delete, ever — corrections always go through Reversal/Adjustment, never mutate a past
 *   ledger entry.
 * - `events/{eventId}` (§17) written in the same transaction as every state change, even though
 *   nothing consumes them yet (Automation Engine/Reports are Phase 6/8) — see `@/modules/event`.
 *
 * `loadMembershipForMerchantTx`, `checkIdempotencyKey`/`recordIdempotencyKey`, and `writeEvent`
 * used to be private copies in this file (Phase 3) — moved to `membership`/`shared`/`event`
 * respectively in Phase 4 once a second caller (`reward/service.ts`) needed the exact same
 * primitives (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่"). `planFifoConsumption`/`applyFifoConsumption`/
 * `writeLedgerEntry`/`recordVisit` stay owned by this file (points-lot/ledger mechanics are
 * inherently points-domain logic) but are now `export`ed for the same reason.
 */

const db = () => getDb();

// --- shared helpers ---------------------------------------------------------------------

/** Exported (Phase 6) — the promotion-automation executor's ADD_POINTS action composes this
 * directly with `createLot`/`writeLedgerEntry` rather than going through `addManualPoints`,
 * because `addManualPoints` enforces §9 Staff Limits (a human-error/fraud control specific to
 * counter staff) which must NOT apply to system-triggered automation — automation has its own
 * governance (`automations.limits`, checked by the executor before dispatch, §16). */
export function computeExpiresAt(policy: PointsExpirationPolicy, earnedAt: Date): Timestamp | null {
  switch (policy.type) {
    case "NEVER":
      return null;
    case "DAYS_AFTER_EARNING":
      return Timestamp.fromMillis(earnedAt.getTime() + policy.days * 24 * 60 * 60 * 1000);
    case "FIXED_DATE":
      return policy.date;
    case "SEASON_BASED":
      // §12 describes this option but never defines what a "season" is anywhere in the
      // architecture — implementing a guessed definition would be inventing a business rule, not
      // filling a gap (see the doc comment on `PointsExpirationPolicy`). Rejected explicitly
      // rather than silently falling back to "never expires".
      throw new ValidationError(
        "pointsExpirationPolicy 'SEASON_BASED' is not computable — its definition is not specified anywhere in FINAL-ARCHITECTURE.md. Choose NEVER, DAYS_AFTER_EARNING, or FIXED_DATE.",
      );
  }
}

/** Staff limit checks (§9) — run inside the same transaction as the ledger write. Windowed sums
 * are computed from `pointsLedger` reads inside the transaction (not a separate check-then-write
 * step). */
async function assertWithinStaffLimits(
  tx: Transaction,
  ctx: AuthContext,
  merchantId: string,
  membershipId: string,
  amount: number,
  staffLimits: StaffLimits,
  isManual: boolean,
): Promise<void> {
  if (amount > staffLimits.maxPointsPerTransaction) {
    throw new ValidationError(
      `Amount ${amount} exceeds maxPointsPerTransaction (${staffLimits.maxPointsPerTransaction}).`,
    );
  }
  if (isManual) {
    if (amount > staffLimits.manualAdjustmentLimit) {
      throw new ValidationError(
        `Manual add ${amount} exceeds manualAdjustmentLimit (${staffLimits.manualAdjustmentLimit}).`,
      );
    }
    if (ctx.role === "STAFF" && amount > staffLimits.managerApprovalThreshold) {
      throw new AuthorizationError(
        `Manual add of ${amount} exceeds managerApprovalThreshold (${staffLimits.managerApprovalThreshold}) — ask a Manager/Owner to add this instead.`,
      );
    }
  }

  const now = Date.now();
  const hourAgo = Timestamp.fromMillis(now - 60 * 60 * 1000);
  const dayAgo = Timestamp.fromMillis(now - 24 * 60 * 60 * 1000);

  const [hourSnap, daySnap] = await Promise.all([
    tx.get(
      db()
        .collection(COLLECTIONS.pointsLedger)
        .where("merchantId", "==", merchantId)
        .where("membershipId", "==", membershipId)
        .where("actorId", "==", ctx.authUid)
        .where("createdAt", ">=", hourAgo),
    ),
    tx.get(
      db()
        .collection(COLLECTIONS.pointsLedger)
        .where("merchantId", "==", merchantId)
        .where("membershipId", "==", membershipId)
        .where("actorId", "==", ctx.authUid)
        .where("createdAt", ">=", dayAgo),
    ),
  ]);

  const positiveSum = (docs: FirebaseFirestore.QueryDocumentSnapshot[]) =>
    docs.reduce((sum, d) => sum + Math.max(0, (d.data().delta as number) ?? 0), 0);

  if (positiveSum(hourSnap.docs) + amount > staffLimits.maxPointsPerHour) {
    throw new ValidationError(
      `This would exceed maxPointsPerHour (${staffLimits.maxPointsPerHour}) for this staff member on this member.`,
    );
  }
  if (positiveSum(daySnap.docs) + amount > staffLimits.maxPointsPerDay) {
    throw new ValidationError(
      `This would exceed maxPointsPerDay (${staffLimits.maxPointsPerDay}) for this staff member on this member.`,
    );
  }
}

/** Creates a new EARN-type lot (used for EARN, positive ADJUSTMENT, and REVERSAL-of-SPEND). */
/** Exported (Phase 6) — see `computeExpiresAt` above for why the automation executor composes
 * this directly instead of calling `addManualPoints`. */
export function createLot(
  tx: Transaction,
  merchantId: string,
  membershipId: string,
  originLedgerEntryId: string,
  amount: number,
  expiresAt: Timestamp | null,
): void {
  const ref = db().collection(COLLECTIONS.pointsLots).doc();
  tx.create(ref, {
    merchantId,
    membershipId,
    originLedgerEntryId,
    earnedAmount: amount,
    remainingAmount: amount,
    expiresAt,
    status: "ACTIVE",
    createdAt: FieldValue.serverTimestamp(),
  });
}

/**
 * FIFO consumption (§12 Spend Flow): loads ACTIVE lots ordered soonest-expiring-first (never-
 * expiring lots last), walks them until `amount` is covered, writing lot decrements + consumption
 * records. Throws `ValidationError` (aborting the whole transaction — no partial write) if the
 * membership doesn't have enough active balance.
 *
 * Firestore orders `null` *first* in ascending order, which is the opposite of "expires soonest
 * first, never-expires last" — so this runs two reads (expiring lots ordered by expiresAt, then
 * never-expiring lots ordered by createdAt) and concatenates them, rather than a single `orderBy`
 * that would put never-expiring lots first.
 */
export interface FifoAllocation {
  lotRef: FirebaseFirestore.DocumentReference;
  lotId: string;
  amountConsumed: number;
  newRemaining: number;
}

/**
 * READ phase of FIFO consumption only — no writes. Split out from `applyFifoConsumption` (below)
 * so callers that still need to write a ledger entry / do other reads afterward can run this
 * first: Firestore transactions require every read in the transaction to happen before any write,
 * and `adjustPoints`/`reversePoints` both need to know the ledger entry's id (itself needs no I/O,
 * see `newLedgerRef()`) before committing it, while still having a FIFO read to run — so the read
 * and write halves of a spend/consumption must be independently callable in that order.
 */
export async function planFifoConsumption(
  tx: Transaction,
  merchantId: string,
  membershipId: string,
  amount: number,
): Promise<FifoAllocation[]> {
  const base = db()
    .collection(COLLECTIONS.pointsLots)
    .where("merchantId", "==", merchantId)
    .where("membershipId", "==", membershipId)
    .where("status", "==", "ACTIVE");

  const [expiringSnap, neverExpiringSnap] = await Promise.all([
    tx.get(base.where("expiresAt", "!=", null).orderBy("expiresAt", "asc").orderBy("createdAt", "asc")),
    tx.get(base.where("expiresAt", "==", null).orderBy("createdAt", "asc")),
  ]);
  const lots = [...expiringSnap.docs, ...neverExpiringSnap.docs];

  const allocations: FifoAllocation[] = [];
  let remaining = amount;
  for (const lotDoc of lots) {
    if (remaining <= 0) break;
    const lot = lotDoc.data() as { remainingAmount: number };
    if (lot.remainingAmount <= 0) continue;

    const take = Math.min(lot.remainingAmount, remaining);
    allocations.push({
      lotRef: lotDoc.ref,
      lotId: lotDoc.id,
      amountConsumed: take,
      newRemaining: lot.remainingAmount - take,
    });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new ValidationError(
      `Insufficient points balance: short by ${remaining} (requested ${amount}).`,
    );
  }
  return allocations;
}

/** WRITE phase of FIFO consumption — applies a plan from `planFifoConsumption`. Pure writes, safe
 * to call after other writes have already happened in the same transaction. */
export function applyFifoConsumption(
  tx: Transaction,
  merchantId: string,
  membershipId: string,
  spendLedgerEntryId: string,
  allocations: FifoAllocation[],
): void {
  for (const a of allocations) {
    tx.update(a.lotRef, {
      remainingAmount: a.newRemaining,
      status: a.newRemaining === 0 ? "DEPLETED" : "ACTIVE",
    });
    tx.create(db().collection(COLLECTIONS.pointsLotConsumptions).doc(), {
      merchantId,
      membershipId,
      spendLedgerEntryId,
      lotId: a.lotId,
      amountConsumed: a.amountConsumed,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
}


async function getMerchantOrThrow(merchantId: string): Promise<MerchantRecord> {
  const snap = await db().collection(COLLECTIONS.merchants).doc(merchantId).get();
  if (!snap.exists) throw new NotFoundError(`Merchant ${merchantId} not found.`);
  return { id: snap.id, ...(snap.data() as Omit<MerchantRecord, "id">) };
}

export type LedgerEntryParams = {
  merchantId: string;
  membershipId: string;
  branchId: string | null;
  type: PointsLedgerEntryType;
  delta: number;
  reason: string;
  sourceType: string;
  sourceRefId: string | null;
  appliedRules?: AppliedRule[];
  actorType: "staff" | "system";
  actorId: string;
  idempotencyKey: string;
  reversalOf?: string;
};

/**
 * Pre-generates a `pointsLedger` doc ref with NO Firestore round-trip (`.doc()` with no args is
 * pure client-side id generation) — lets a caller know the id a ledger entry will have (e.g. to
 * pass as `spendLedgerEntryId` into a FIFO consumption read) *before* committing to the write
 * itself, which matters when that caller still has reads left to run: Firestore transactions
 * require every read to happen before any write, and this file has more than one call site that
 * needs to read (a FIFO lot query, an origin-lot lookup) in between "know the future ledger id"
 * and "actually write the ledger entry" — see `adjustPoints`/`reversePoints`.
 */
function newLedgerRef(): FirebaseFirestore.DocumentReference {
  return db().collection(COLLECTIONS.pointsLedger).doc();
}

/**
 * The single low-level primitive every points-ledger-creating write in the codebase funnels
 * through, directly or via `writeLedgerEntry` below.
 *
 * NOTE on Emergency Control's `pointsEngineFrozen` check (§37.2): it does NOT live here, on
 * purpose — `reversePoints` below calls `writeLedgerEntry` a SECOND time (the shortfall
 * ADJUSTMENT entry) after other writes (`tx.update(originalRef, ...)`, a lot's
 * `remainingAmount`) have already happened earlier in the same transaction, and Firestore
 * forbids any `tx.get()` read once a transaction has issued a write. A check embedded here would
 * work for every call site except that second one. Each of the six functions that ultimately
 * create a ledger entry (`earnPointsByRule`, `addManualPoints`, `adjustPoints`, `reversePoints`,
 * `redeemReward` in `reward/service.ts`, and the automation executor's ADD_POINTS branch) instead
 * calls `assertPointsEngineNotFrozenTx` explicitly as the FIRST read of its own transaction —
 * still one shared enforcement function (no duplicated logic), just not one shared call site.
 * Kept async regardless, matching every other write helper in this file.
 */
async function createLedgerEntry(
  tx: Transaction,
  ref: FirebaseFirestore.DocumentReference,
  params: LedgerEntryParams,
): Promise<void> {
  tx.create(ref, { ...params, createdAt: FieldValue.serverTimestamp() });
}

/** Convenience wrapper for call sites with no reads left to run afterward (no risk of a
 * read-after-write ordering violation) — generates the ref and writes in one step. */
export async function writeLedgerEntry(
  tx: Transaction,
  params: LedgerEntryParams,
): Promise<FirebaseFirestore.DocumentReference> {
  const ref = newLedgerRef();
  await createLedgerEntry(tx, ref, params);
  return ref;
}

/** `visits/{visitId}.relatedRefs` (§15) — which of a Visit's possible related entities this
 * particular visit is tied to. All optional; a caller passes whichever apply. */
export interface VisitRelatedRefs {
  pointsLedgerEntryId?: string;
  couponInstanceId?: string;
  voucherInstanceId?: string;
}

export function recordVisit(
  tx: Transaction,
  params: {
    merchantId: string;
    membershipId: string;
    branchId: string | null;
    // 'AUTOMATION' added Phase 6 — completes §15's documented `source` enum (`visits.source:
    // 'STAFF_SCAN'|'STAFF_SEARCH'|'MANUAL_ENTRY'|'AUTOMATION'`), which had no producer until now.
    source: "STAFF_SCAN" | "STAFF_SEARCH" | "MANUAL_ENTRY" | "AUTOMATION";
    countsAsVisit: boolean;
    relatedRefs: VisitRelatedRefs;
    createdBy: string;
    /** §15 "Activity Stats Maintenance" (Phase 8, Locked) — the membership's current
     * `activityStats.firstVisitAt`, from a read the caller already performed earlier in the SAME
     * transaction (never fetched fresh here — every caller of `recordVisit` does its own writes
     * before/around this call, and Firestore transactions forbid reads after writes). `null` means
     * this is the member's first-ever counted visit, so `firstVisitAt` gets set now too; a
     * Timestamp means it's already set and must be left untouched. Ignored when
     * `countsAsVisit=false` — corrections/automation bonuses are never "a visit" (§15) and must
     * never perturb `activityStats`. */
    currentFirstVisitAt: Timestamp | null;
  },
): void {
  const ref = db().collection(COLLECTIONS.visits).doc();
  tx.create(ref, {
    merchantId: params.merchantId,
    membershipId: params.membershipId,
    branchId: params.branchId,
    source: params.source,
    countsAsVisit: params.countsAsVisit,
    relatedRefs: params.relatedRefs,
    recordedAt: FieldValue.serverTimestamp(),
    createdBy: params.createdBy,
  });

  if (params.countsAsVisit) {
    // §15 Activity Stats Maintenance (Phase 8, Locked): `lastVisitAt` always advances to now;
    // `firstVisitAt` is set exactly once, the first time it's still null. `visitCount30d`/`90d`
    // are a ROLLING window, not maintained here — they're recomputed daily by
    // `dailyAutomationBatch` (functions/src/index.ts) from the `visits` collection itself, per the
    // same decision, to avoid a monotonically-growing counter that would never reflect "last N
    // days" correctly.
    tx.update(db().collection(COLLECTIONS.memberships).doc(params.membershipId), {
      "activityStats.lastVisitAt": FieldValue.serverTimestamp(),
      ...(params.currentFirstVisitAt === null
        ? { "activityStats.firstVisitAt": FieldValue.serverTimestamp() }
        : {}),
    });

    writeEvent(tx, {
      merchantId: params.merchantId,
      type: "visit.recorded",
      membershipId: params.membershipId,
      payload: { visitId: ref.id, source: params.source, ...params.relatedRefs },
    });
  }
}

// --- Public operations --------------------------------------------------------------------

export interface EarnPointsByRuleInput {
  membershipId: string;
  branchId: string | null;
  sourceType: "PER_UNIT" | "PER_VISIT";
  units?: number;
  visitSource: "STAFF_SCAN" | "STAFF_SEARCH";
  idempotencyKey: string;
}

export interface EarnResult {
  ledgerEntryId: string;
  delta: number;
  appliedRules: AppliedRule[];
}

/** Rule-based earn (§11 stacking algorithm + §12 EARN flow). Staff/Manager/Owner — POINTS_ADD_RULE. */
export async function earnPointsByRule(ctx: AuthContext, input: EarnPointsByRuleInput): Promise<EarnResult> {
  requirePermission(ctx, PERMISSIONS.POINTS_ADD_RULE, ctx.merchantId);
  if (input.branchId) requireBranchScope(ctx, input.branchId);

  const [merchant, rulesSnap] = await Promise.all([
    getMerchantOrThrow(ctx.merchantId),
    db().collection(COLLECTIONS.pointRules).where("merchantId", "==", ctx.merchantId).get(),
  ]);
  const rules = rulesSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PointRule, "id">) }));

  const now = new Date();
  const { finalPoints, appliedRules } = evaluatePointRules(rules, {
    sourceType: input.sourceType,
    units: input.units,
    branchId: input.branchId,
    now,
  });

  if (finalPoints <= 0) {
    throw new ValidationError("No active point rule produced a positive amount for this event.");
  }

  return db().runTransaction(async (tx) => {
    await assertPointsEngineNotFrozenTx(tx, ctx.merchantId); // Emergency Control §37.2 — first read
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "points.earn", input.idempotencyKey);
    if (existing) return { ledgerEntryId: existing, delta: finalPoints, appliedRules };

    const membership = await loadMembershipForMerchantTx(tx, input.membershipId, ctx.merchantId);
    await assertWithinStaffLimits(
      tx,
      ctx,
      ctx.merchantId,
      input.membershipId,
      finalPoints,
      merchant.staffLimits,
      false,
    );

    const ledgerRef = await writeLedgerEntry(tx, {
      merchantId: ctx.merchantId,
      membershipId: input.membershipId,
      branchId: input.branchId,
      type: "EARN",
      delta: finalPoints,
      reason: `Earned via ${input.sourceType} rule`,
      sourceType: input.sourceType,
      sourceRefId: null,
      appliedRules,
      actorType: "staff",
      actorId: ctx.authUid,
      idempotencyKey: input.idempotencyKey,
    });

    createLot(
      tx,
      ctx.merchantId,
      input.membershipId,
      ledgerRef.id,
      finalPoints,
      computeExpiresAt(merchant.pointsExpirationPolicy, now),
    );

    tx.update(db().collection(COLLECTIONS.memberships).doc(input.membershipId), {
      pointsBalance: FieldValue.increment(finalPoints),
      pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
    });

    recordVisit(tx, {
      merchantId: ctx.merchantId,
      membershipId: input.membershipId,
      branchId: input.branchId,
      source: input.visitSource,
      countsAsVisit: true,
      relatedRefs: { pointsLedgerEntryId: ledgerRef.id },
      createdBy: ctx.authUid,
      currentFirstVisitAt: membership.activityStats.firstVisitAt,
    });

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "points.earned",
      membershipId: input.membershipId,
      payload: { ledgerEntryId: ledgerRef.id, delta: finalPoints, sourceType: input.sourceType, appliedRules },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "points.earn", input.idempotencyKey, ledgerRef.id);

    void membership; // loaded for tenant-check + transaction-read-before-write ordering only
    return { ledgerEntryId: ledgerRef.id, delta: finalPoints, appliedRules };
  });
}

export interface ManualAddPointsInput {
  membershipId: string;
  branchId: string | null;
  amount: number;
  reason: string;
  idempotencyKey: string;
}

/** Manual add, NOT through the Rule Engine (§9, §11). Staff/Manager/Owner — POINTS_ADD_MANUAL,
 * capped by `staffLimits.manualAdjustmentLimit` (+ `managerApprovalThreshold` for Staff role). */
export async function addManualPoints(ctx: AuthContext, input: ManualAddPointsInput): Promise<EarnResult> {
  requirePermission(ctx, PERMISSIONS.POINTS_ADD_MANUAL, ctx.merchantId);
  if (input.branchId) requireBranchScope(ctx, input.branchId);
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new ValidationError("amount must be a positive integer.");
  }
  if (input.reason.trim().length === 0) throw new ValidationError("reason is required.");

  const merchant = await getMerchantOrThrow(ctx.merchantId);
  const now = new Date();

  return db().runTransaction(async (tx) => {
    await assertPointsEngineNotFrozenTx(tx, ctx.merchantId); // Emergency Control §37.2 — first read
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "points.manual_add", input.idempotencyKey);
    if (existing) return { ledgerEntryId: existing, delta: input.amount, appliedRules: [] };

    await loadMembershipForMerchantTx(tx, input.membershipId, ctx.merchantId);
    await assertWithinStaffLimits(
      tx,
      ctx,
      ctx.merchantId,
      input.membershipId,
      input.amount,
      merchant.staffLimits,
      true,
    );

    const ledgerRef = await writeLedgerEntry(tx, {
      merchantId: ctx.merchantId,
      membershipId: input.membershipId,
      branchId: input.branchId,
      type: "EARN",
      delta: input.amount,
      reason: input.reason,
      sourceType: "MANUAL",
      sourceRefId: null,
      actorType: "staff",
      actorId: ctx.authUid,
      idempotencyKey: input.idempotencyKey,
    });

    createLot(
      tx,
      ctx.merchantId,
      input.membershipId,
      ledgerRef.id,
      input.amount,
      computeExpiresAt(merchant.pointsExpirationPolicy, now),
    );

    tx.update(db().collection(COLLECTIONS.memberships).doc(input.membershipId), {
      pointsBalance: FieldValue.increment(input.amount),
      pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
    });

    // §15: manual/correction entries must NOT be assumed to be a visit — no Visit record here.

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "points.earned",
      membershipId: input.membershipId,
      payload: { ledgerEntryId: ledgerRef.id, delta: input.amount, sourceType: "MANUAL", reason: input.reason },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "points.manual_add", input.idempotencyKey, ledgerRef.id);
    return { ledgerEntryId: ledgerRef.id, delta: input.amount, appliedRules: [] };
  });
}

export interface AdjustPointsInput {
  membershipId: string;
  /** Positive to grant, negative to deduct. */
  delta: number;
  reason: string;
  idempotencyKey: string;
}

/** Owner/Manager only — POINTS_ADJUST. Positive delta creates a new lot (like EARN); negative
 * delta consumes via the same FIFO logic as a spend, recorded as type ADJUSTMENT either way. */
export async function adjustPoints(ctx: AuthContext, input: AdjustPointsInput): Promise<{ ledgerEntryId: string }> {
  requirePermission(ctx, PERMISSIONS.POINTS_ADJUST, ctx.merchantId);
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new ValidationError("delta must be a non-zero integer.");
  }
  if (input.reason.trim().length === 0) throw new ValidationError("reason is required for an adjustment.");

  const merchant = await getMerchantOrThrow(ctx.merchantId);
  const now = new Date();

  return db().runTransaction(async (tx) => {
    await assertPointsEngineNotFrozenTx(tx, ctx.merchantId); // Emergency Control §37.2 — first read
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "points.adjust", input.idempotencyKey);
    if (existing) return { ledgerEntryId: existing };

    await loadMembershipForMerchantTx(tx, input.membershipId, ctx.merchantId);

    // §12/Firestore: ALL reads in a transaction must happen before ANY write — so a negative
    // delta's FIFO read (`planFifoConsumption`) must run now, before `createLedgerEntry` below,
    // even though the ledger entry it needs to reference is what triggered this consumption.
    // `newLedgerRef()` hands back the future ledger entry's id with no I/O, so the read can
    // reference it without the write having happened yet.
    const ledgerRef = newLedgerRef();
    const fifoAllocations =
      input.delta < 0
        ? await planFifoConsumption(tx, ctx.merchantId, input.membershipId, -input.delta)
        : null;

    await createLedgerEntry(tx, ledgerRef, {
      merchantId: ctx.merchantId,
      membershipId: input.membershipId,
      branchId: null,
      type: "ADJUSTMENT",
      delta: input.delta,
      reason: input.reason,
      sourceType: "MANUAL_ADJUSTMENT",
      sourceRefId: null,
      actorType: "staff",
      actorId: ctx.authUid,
      idempotencyKey: input.idempotencyKey,
    });

    if (input.delta > 0) {
      createLot(
        tx,
        ctx.merchantId,
        input.membershipId,
        ledgerRef.id,
        input.delta,
        computeExpiresAt(merchant.pointsExpirationPolicy, now),
      );
    } else if (fifoAllocations) {
      applyFifoConsumption(tx, ctx.merchantId, input.membershipId, ledgerRef.id, fifoAllocations);
    }

    tx.update(db().collection(COLLECTIONS.memberships).doc(input.membershipId), {
      pointsBalance: FieldValue.increment(input.delta),
      pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
    });

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "points.adjusted",
      membershipId: input.membershipId,
      payload: { ledgerEntryId: ledgerRef.id, delta: input.delta, reason: input.reason },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "points.adjust", input.idempotencyKey, ledgerRef.id);
    return { ledgerEntryId: ledgerRef.id };
  });
}

export interface ReversePointsInput {
  ledgerEntryId: string;
  reason: string;
  idempotencyKey: string;
}

/**
 * Owner/Manager only — POINTS_REVERSE (§12 Reversal):
 * - Reversal of EARN: reduces `remainingAmount` of the origin lot by whatever is still there; if
 *   the lot has already been partly/fully spent, the shortfall becomes a negative ADJUSTMENT
 *   (can't "un-spend" points that already left via a different lot/consumption).
 * - Reversal of SPEND: creates a brand-new lot for the reversed amount under the merchant's
 *   *current* expiration policy — never tries to restore the original lot.
 */
export async function reversePoints(ctx: AuthContext, input: ReversePointsInput): Promise<{ ledgerEntryId: string }> {
  requirePermission(ctx, PERMISSIONS.POINTS_REVERSE, ctx.merchantId);
  if (input.reason.trim().length === 0) throw new ValidationError("reason is required for a reversal.");

  const merchant = await getMerchantOrThrow(ctx.merchantId);
  const now = new Date();

  return db().runTransaction(async (tx) => {
    await assertPointsEngineNotFrozenTx(tx, ctx.merchantId); // Emergency Control §37.2 — first read
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "points.reverse", input.idempotencyKey);
    if (existing) return { ledgerEntryId: existing };

    const originalRef = db().collection(COLLECTIONS.pointsLedger).doc(input.ledgerEntryId);
    const originalSnap = await tx.get(originalRef);
    if (!originalSnap.exists) throw new NotFoundError(`Ledger entry ${input.ledgerEntryId} not found.`);
    const original = originalSnap.data() as {
      merchantId: string;
      membershipId: string;
      type: PointsLedgerEntryType;
      delta: number;
      reversedBy?: string;
    };
    if (original.merchantId !== ctx.merchantId) {
      throw new TenantIsolationError(
        `Staff of merchant ${ctx.merchantId} attempted to reverse a ledger entry of merchant ${original.merchantId}.`,
      );
    }
    if (original.reversedBy) {
      throw new ConflictError("This ledger entry has already been reversed.");
    }
    if (original.type !== "EARN" && original.type !== "SPEND") {
      throw new ValidationError(`Cannot reverse a ledger entry of type ${original.type}.`);
    }

    const reversalDelta = -original.delta; // EARN(+) -> reversal(-); SPEND(-) -> reversal(+)

    // §12/Firestore: this read must happen here, before ANY write in this transaction (including
    // the ledger/originalRef writes just below) — moved up from right before its point of use to
    // satisfy "all reads before all writes", the same fix as `adjustPoints` above.
    const originLotDoc =
      original.type === "EARN"
        ? (
            await tx.get(
              db()
                .collection(COLLECTIONS.pointsLots)
                .where("merchantId", "==", ctx.merchantId)
                .where("originLedgerEntryId", "==", input.ledgerEntryId)
                .limit(1),
            )
          ).docs[0]
        : undefined;

    const reversalRef = await writeLedgerEntry(tx, {
      merchantId: ctx.merchantId,
      membershipId: original.membershipId,
      branchId: null,
      type: "REVERSAL",
      delta: reversalDelta,
      reason: input.reason,
      sourceType: "REVERSAL",
      sourceRefId: input.ledgerEntryId,
      actorType: "staff",
      actorId: ctx.authUid,
      idempotencyKey: input.idempotencyKey,
      reversalOf: input.ledgerEntryId,
    });
    tx.update(originalRef, { reversedBy: reversalRef.id });

    if (original.type === "EARN") {
      // Reduce the origin lot by whatever remains; shortfall (already spent) → negative ADJUSTMENT.
      const lotDoc = originLotDoc;
      const remainingInLot = lotDoc ? ((lotDoc.data().remainingAmount as number) ?? 0) : 0;
      const reduceBy = Math.min(remainingInLot, original.delta);
      if (lotDoc && reduceBy > 0) {
        const newRemaining = remainingInLot - reduceBy;
        tx.update(lotDoc.ref, {
          remainingAmount: newRemaining,
          status: newRemaining === 0 ? "DEPLETED" : "ACTIVE",
        });
      }
      const shortfall = original.delta - reduceBy;
      if (shortfall > 0) {
        // Already-spent portion: a pure audit-trail ADJUSTMENT entry documenting *why* the
        // reversal's total balance decrement (reversalDelta = -original.delta, applied once below)
        // is bigger than what the origin lot alone could give back — it must NOT also FIFO-consume
        // against the member's OTHER, unrelated active lots: that would (a) corrupt
        // those lots' audit trail with a `pointsLotConsumptions` record that looks like a genuine
        // customer redemption but is really an unrelated correction, and (b) make an otherwise
        // always-recordable reversal fail outright with "insufficient balance" whenever the member
        // doesn't happen to have that much *other* balance lying around — a correction must always
        // be recordable (§34 "ห้าม hard delete... ใช้ Reversal pattern เสมอ"), it can never be
        // blocked by current balance state. The member's balance legitimately going below the sum
        // of their remaining active lots here (a "debt" from having spent since-reversed points) is
        // the intended, historically-accurate outcome, not a bug to paper over by draining a
        // different lot to make the numbers match.
        await writeLedgerEntry(tx, {
          merchantId: ctx.merchantId,
          membershipId: original.membershipId,
          branchId: null,
          type: "ADJUSTMENT",
          delta: -shortfall,
          reason: `Reversal shortfall for ${input.ledgerEntryId} (already spent)`,
          sourceType: "REVERSAL_SHORTFALL",
          sourceRefId: input.ledgerEntryId,
          actorType: "system",
          actorId: ctx.authUid,
          idempotencyKey: `${input.idempotencyKey}:shortfall`,
        });
      }
    } else {
      // Reversal of SPEND: brand-new lot under the CURRENT expiration policy (§12).
      createLot(
        tx,
        ctx.merchantId,
        original.membershipId,
        reversalRef.id,
        reversalDelta,
        computeExpiresAt(merchant.pointsExpirationPolicy, now),
      );
    }

    tx.update(db().collection(COLLECTIONS.memberships).doc(original.membershipId), {
      pointsBalance: FieldValue.increment(reversalDelta),
      pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
    });

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "points.reversed",
      membershipId: original.membershipId,
      payload: { ledgerEntryId: reversalRef.id, reversalOf: input.ledgerEntryId, delta: reversalDelta },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "points.reverse", input.idempotencyKey, reversalRef.id);
    return { ledgerEntryId: reversalRef.id };
  });
}

/** The actual query — reused by both the staff-facing `getPointsHistory` (permission-gated) and
 * the customer-portal service (authorized differently: by the caller already having resolved
 * `membershipId` from the customer's own verified identity, never a client-supplied value). One
 * implementation of "how do we find this membership's ledger entries", two authorization entry
 * points — matching the same pattern `resolveOrCreateLineMembership` already established for
 * customer- vs staff-facing membership access (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่"). */
export async function listPointsLedgerForMembership(
  merchantId: string,
  membershipId: string,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  const snap = await db()
    .collection(COLLECTIONS.pointsLedger)
    .where("merchantId", "==", merchantId)
    .where("membershipId", "==", membershipId)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getPointsHistory(
  ctx: AuthContext,
  membershipId: string,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  requirePermission(ctx, PERMISSIONS.POINTS_VIEW_HISTORY, ctx.merchantId);
  await loadMembershipForMerchantNoTx(membershipId, ctx.merchantId);
  return listPointsLedgerForMembership(ctx.merchantId, membershipId);
}

async function loadMembershipForMerchantNoTx(membershipId: string, merchantId: string): Promise<void> {
  const snap = await db().collection(COLLECTIONS.memberships).doc(membershipId).get();
  if (!snap.exists) throw new NotFoundError(`Membership ${membershipId} not found.`);
  if ((snap.data() as { merchantId: string }).merchantId !== merchantId) {
    throw new TenantIsolationError(
      `Staff of merchant ${merchantId} attempted to view points history of a membership of another merchant.`,
    );
  }
}
