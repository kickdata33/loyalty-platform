import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";

import { evaluatePointRules } from "@/modules/points/rule-engine";
import type {
  AppliedRule,
  PointRule,
  PointsEventType,
  PointsLedgerEntryType,
} from "@/modules/points/types";
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
import type { AuthContext } from "@/modules/shared/types";
import type { MembershipRecord } from "@/modules/membership/types";

/**
 * Points Ledger + Lots + FIFO + Expiration + Reversal (FINAL-ARCHITECTURE.md §12) — the
 * transactional core of Phase 3.
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
 *   nothing consumes them yet (Automation Engine/Reports are Phase 6/8) — see `writeEvent()`.
 */

const db = () => getDb();

// --- shared helpers ---------------------------------------------------------------------

async function loadMembershipForMerchant(
  tx: Transaction,
  membershipId: string,
  merchantId: string,
): Promise<MembershipRecord> {
  const ref = db().collection(COLLECTIONS.memberships).doc(membershipId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new NotFoundError(`Membership ${membershipId} not found.`);
  const data = { id: snap.id, ...(snap.data() as Omit<MembershipRecord, "id">) };
  if (data.merchantId !== merchantId) {
    // `requirePermission(ctx, PERM, ctx.merchantId)` above is trivially true (resourceMerchantId
    // is the caller's own merchantId, not yet the *target* resource's) — this is the actual
    // tenant-isolation boundary for a caller-supplied membershipId, so it must throw the same
    // `TenantIsolationError` every other cross-tenant resource lookup throws (§10, §26), not a
    // generic `AuthorizationError` — tests assert on the specific type (see tenant-isolation.test.ts).
    throw new TenantIsolationError(
      `Staff of merchant ${merchantId} attempted to access a membership of merchant ${data.merchantId}.`,
    );
  }
  return data;
}

/** Checks + records an idempotency key inside the caller's transaction. Returns the prior
 * resultRef if this key was already used (idempotent replay), or null if this is a first use. */
async function checkIdempotencyKey(
  tx: Transaction,
  merchantId: string,
  operationType: string,
  idempotencyKey: string,
): Promise<string | null> {
  if (!idempotencyKey || idempotencyKey.trim().length < 8) {
    throw new ValidationError("idempotencyKey is required (min 8 chars).");
  }
  const ref = db().collection(COLLECTIONS.idempotencyKeys).doc(idempotencyKey);
  const snap = await tx.get(ref);
  if (snap.exists) {
    const data = snap.data() as { merchantId: string; operationType: string; resultRef: string };
    if (data.merchantId !== merchantId || data.operationType !== operationType) {
      // Same key reused for a different merchant/operation — never trust it as a replay.
      throw new ConflictError("idempotencyKey was already used for a different operation.");
    }
    return data.resultRef;
  }
  return null;
}

function recordIdempotencyKey(
  tx: Transaction,
  merchantId: string,
  operationType: string,
  idempotencyKey: string,
  resultRef: string,
): void {
  const ref = db().collection(COLLECTIONS.idempotencyKeys).doc(idempotencyKey);
  tx.create(ref, { merchantId, operationType, resultRef, createdAt: FieldValue.serverTimestamp() });
}

function computeExpiresAt(policy: PointsExpirationPolicy, earnedAt: Date): Timestamp | null {
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
function createLot(
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
interface FifoAllocation {
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
async function planFifoConsumption(
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
function applyFifoConsumption(
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

type LedgerEntryParams = {
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

function createLedgerEntry(
  tx: Transaction,
  ref: FirebaseFirestore.DocumentReference,
  params: LedgerEntryParams,
): void {
  tx.create(ref, { ...params, createdAt: FieldValue.serverTimestamp() });
}

/** Convenience wrapper for call sites with no reads left to run afterward (no risk of a
 * read-after-write ordering violation) — generates the ref and writes in one step. */
function writeLedgerEntry(
  tx: Transaction,
  params: LedgerEntryParams,
): FirebaseFirestore.DocumentReference {
  const ref = newLedgerRef();
  createLedgerEntry(tx, ref, params);
  return ref;
}

/**
 * Writes `events/{eventId}` (§5, §17) in the SAME transaction as the state change it reports —
 * "atomic ป้องกัน event หายเมื่อ state เปลี่ยนแต่ event เขียนไม่สำเร็จ". Nothing consumes these yet
 * (Automation Engine is Phase 6, Report aggregates are Phase 8), but the write itself is not
 * optional/deferrable: retrofitting it into these already-shipped ledger transactions later would
 * mean touching every write path in this file again, exactly what atomicity-at-the-source avoids.
 */
function writeEvent(
  tx: Transaction,
  params: { merchantId: string; type: PointsEventType; membershipId: string; payload: Record<string, unknown> },
): void {
  const ref = db().collection(COLLECTIONS.events).doc();
  tx.create(ref, {
    merchantId: params.merchantId,
    type: params.type,
    membershipId: params.membershipId,
    payload: params.payload,
    schemaVersion: 1,
    createdAt: FieldValue.serverTimestamp(),
  });
}

function recordVisit(
  tx: Transaction,
  params: {
    merchantId: string;
    membershipId: string;
    branchId: string | null;
    source: "STAFF_SCAN" | "STAFF_SEARCH" | "MANUAL_ENTRY";
    countsAsVisit: boolean;
    pointsLedgerEntryId: string;
    createdBy: string;
  },
): void {
  const ref = db().collection(COLLECTIONS.visits).doc();
  tx.create(ref, {
    merchantId: params.merchantId,
    membershipId: params.membershipId,
    branchId: params.branchId,
    source: params.source,
    countsAsVisit: params.countsAsVisit,
    relatedRefs: { pointsLedgerEntryId: params.pointsLedgerEntryId },
    recordedAt: FieldValue.serverTimestamp(),
    createdBy: params.createdBy,
  });

  if (params.countsAsVisit) {
    writeEvent(tx, {
      merchantId: params.merchantId,
      type: "visit.recorded",
      membershipId: params.membershipId,
      payload: { visitId: ref.id, source: params.source, pointsLedgerEntryId: params.pointsLedgerEntryId },
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
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "points.earn", input.idempotencyKey);
    if (existing) return { ledgerEntryId: existing, delta: finalPoints, appliedRules };

    const membership = await loadMembershipForMerchant(tx, input.membershipId, ctx.merchantId);
    await assertWithinStaffLimits(
      tx,
      ctx,
      ctx.merchantId,
      input.membershipId,
      finalPoints,
      merchant.staffLimits,
      false,
    );

    const ledgerRef = writeLedgerEntry(tx, {
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
      pointsLedgerEntryId: ledgerRef.id,
      createdBy: ctx.authUid,
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
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "points.manual_add", input.idempotencyKey);
    if (existing) return { ledgerEntryId: existing, delta: input.amount, appliedRules: [] };

    await loadMembershipForMerchant(tx, input.membershipId, ctx.merchantId);
    await assertWithinStaffLimits(
      tx,
      ctx,
      ctx.merchantId,
      input.membershipId,
      input.amount,
      merchant.staffLimits,
      true,
    );

    const ledgerRef = writeLedgerEntry(tx, {
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
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "points.adjust", input.idempotencyKey);
    if (existing) return { ledgerEntryId: existing };

    await loadMembershipForMerchant(tx, input.membershipId, ctx.merchantId);

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

    createLedgerEntry(tx, ledgerRef, {
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

    const reversalRef = writeLedgerEntry(tx, {
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
        writeLedgerEntry(tx, {
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

export async function getPointsHistory(
  ctx: AuthContext,
  membershipId: string,
): Promise<Array<Record<string, unknown> & { id: string }>> {
  requirePermission(ctx, PERMISSIONS.POINTS_VIEW_HISTORY, ctx.merchantId);
  await loadMembershipForMerchantNoTx(membershipId, ctx.merchantId);

  const snap = await db()
    .collection(COLLECTIONS.pointsLedger)
    .where("merchantId", "==", ctx.merchantId)
    .where("membershipId", "==", membershipId)
    .orderBy("createdAt", "desc")
    .get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
