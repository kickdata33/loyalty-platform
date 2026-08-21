import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { assertPointsEngineNotFrozenTx } from "@/modules/emergency-control/service";
import { writeEvent } from "@/modules/event/service";
import { getMembership, loadMembershipForMerchantTx } from "@/modules/membership/service";
import type { MembershipRecord } from "@/modules/membership/types";
import {
  applyFifoConsumption,
  planFifoConsumption,
  recordVisit,
  writeLedgerEntry,
} from "@/modules/points/ledger-service";
import { requireBranchScope, requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { RewardTemplate, RewardType, VoucherExpiryRule, VoucherInstance } from "@/modules/reward/types";
import {
  ConflictError,
  NotFoundError,
  TenantIsolationError,
  ValidationError,
} from "@/modules/shared/errors";
import { branchesCollection, COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { checkIdempotencyKey, recordIdempotencyKey } from "@/modules/shared/idempotency";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Reward Template CRUD + Redeem/Use flow (FINAL-ARCHITECTURE.md §13) — Phase 4.
 *
 * Redeem reuses the Phase 3 Points Ledger's FIFO-consumption primitives directly
 * (`planFifoConsumption`/`applyFifoConsumption`/`writeLedgerEntry`, all exported from
 * `points/ledger-service.ts`) inside its OWN transaction, rather than re-implementing FIFO/ledger
 * logic here — spending points is inherently points-domain logic regardless of *why* the spend
 * happened (§13's SPEND entry is tagged `sourceType: 'REWARD_REDEMPTION'`, `sourceRefId:
 * <voucherId>` to trace back), and CLAUDE.md forbids duplicating it ("ห้ามมี logic ซ้ำสองที่").
 *
 * Locked Phase 4 Planning Review decisions, implemented exactly as approved:
 * - Voucher validity after a redemption is reversed: `confirmVoucherUse` reads the SPEND
 *   `pointsLedger` entry referenced by `voucher.sourceLedgerEntryId` and rejects Use if it has
 *   been reversed (`reversedBy` set) — a one-directional reward→points read only. Nothing in
 *   `points/ledger-service.ts` is aware rewards exist; `reversePoints` was NOT modified.
 * - Voucher expiration: lazy, checked only at Use time against `voucher.expiresAt`. No scheduled
 *   sweep Cloud Function — §32's Scheduled row lists `pointsExpiration`/`couponExpiration` but
 *   never a reward/voucher equivalent, and a sweep was explicitly deferred by the Planning Review.
 */

const VALID_TYPES: readonly RewardType[] = [
  "FIXED_DISCOUNT",
  "PERCENTAGE_DISCOUNT",
  "FREE_PRODUCT",
  "FREE_SERVICE",
  "PRIVILEGE",
  "PHYSICAL_REWARD",
  "CUSTOM",
];

function validateVoucherExpiryRule(rule: VoucherExpiryRule): void {
  switch (rule.type) {
    case "NEVER":
      return;
    case "DAYS_AFTER_REDEMPTION":
      if (!Number.isInteger(rule.days) || rule.days <= 0) {
        throw new ValidationError("voucherExpiryRule.days must be a positive integer.");
      }
      return;
    case "FIXED_DATE":
      if (!rule.date) throw new ValidationError("voucherExpiryRule.date is required for FIXED_DATE.");
      return;
  }
}

function computeVoucherExpiresAt(rule: VoucherExpiryRule, redeemedAt: Date): Timestamp | null {
  switch (rule.type) {
    case "NEVER":
      return null;
    case "DAYS_AFTER_REDEMPTION":
      return Timestamp.fromMillis(redeemedAt.getTime() + rule.days * 24 * 60 * 60 * 1000);
    case "FIXED_DATE":
      return rule.date;
  }
}

function rewardAppliesToBranch(template: RewardTemplate, branchId: string | null): boolean {
  if (template.branchScope.length === 0) return true; // empty = all branches (§13, same convention as §11)
  return branchId !== null && template.branchScope.includes(branchId);
}

// --- Reward Template CRUD (Owner/Manager — REWARD_MANAGE) ----------------------------------

export interface CreateRewardTemplateInput {
  name: string;
  description?: string;
  type: RewardType;
  requiredPoints: number;
  stock?: number | null;
  limitPerMember?: number | null;
  branchScope?: string[];
  startAt?: Date | null;
  endAt?: Date | null;
  voucherExpiryRule?: VoucherExpiryRule;
}

export async function createRewardTemplate(ctx: AuthContext, input: CreateRewardTemplateInput): Promise<string> {
  requirePermission(ctx, PERMISSIONS.REWARD_MANAGE, ctx.merchantId);
  if (input.name.trim().length === 0) throw new ValidationError("name must not be empty.");
  if (!VALID_TYPES.includes(input.type)) throw new ValidationError(`Invalid reward type: ${input.type}`);
  if (!Number.isInteger(input.requiredPoints) || input.requiredPoints <= 0) {
    throw new ValidationError("requiredPoints must be a positive integer.");
  }
  if (input.stock !== undefined && input.stock !== null) {
    if (!Number.isInteger(input.stock) || input.stock < 0) {
      throw new ValidationError("stock must be a non-negative integer, or null for unlimited.");
    }
  }
  if (input.limitPerMember !== undefined && input.limitPerMember !== null) {
    if (!Number.isInteger(input.limitPerMember) || input.limitPerMember <= 0) {
      throw new ValidationError("limitPerMember must be a positive integer, or null for unlimited.");
    }
  }
  const voucherExpiryRule = input.voucherExpiryRule ?? { type: "NEVER" as const };
  validateVoucherExpiryRule(voucherExpiryRule);

  // §13 "Start/End Date" — reject a nonsensical window at create time rather than silently
  // producing a template that can never legally become active (endAt <= startAt would make
  // `assertRewardIsRedeemable`'s startAt/endAt checks contradict each other for every possible
  // `now`).
  if (input.startAt && input.endAt && input.endAt.getTime() <= input.startAt.getTime()) {
    throw new ValidationError("endAt must be after startAt.");
  }

  const branchScope = input.branchScope ?? [];
  if (branchScope.length > 0) {
    // §13 "Allowed Branches" — every id must be a REAL branch of the CALLER'S OWN merchant, same
    // load-then-validate pattern `createMembership` already uses for a single `branchId` (§10):
    // never trust a client-supplied id as-is, and never let a forged/foreign/nonexistent branch
    // id silently get stored (it would otherwise make the reward simply unredeemable at every
    // real branch the merchant actually has — a self-service correctness gap, not just a security
    // one, since `branchScope` is validated by direct Firestore existence, not merely a merchantId
    // string comparison that a same-merchant caller could still get wrong).
    const branchSnaps = await Promise.all(
      branchScope.map((branchId) => branchesCollection(ctx.merchantId).doc(branchId).get()),
    );
    const missing = branchScope.filter((_, i) => !branchSnaps[i].exists);
    if (missing.length > 0) {
      throw new ValidationError(
        `branchScope contains branch id(s) that do not exist for this merchant: ${missing.join(", ")}.`,
      );
    }
  }

  const ref = getDb().collection(COLLECTIONS.rewardTemplates).doc();
  await ref.set({
    merchantId: ctx.merchantId,
    name: input.name,
    description: input.description ?? "",
    type: input.type,
    enabled: true,
    requiredPoints: input.requiredPoints,
    stock: input.stock ?? null,
    limitPerMember: input.limitPerMember ?? null,
    branchScope,
    startAt: input.startAt ? Timestamp.fromDate(input.startAt) : null,
    endAt: input.endAt ? Timestamp.fromDate(input.endAt) : null,
    voucherExpiryRule,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "reward.created",
    targetType: "rewardTemplate",
    targetId: ref.id,
    after: { name: input.name, type: input.type, requiredPoints: input.requiredPoints },
  });

  return ref.id;
}

export async function setRewardTemplateEnabled(
  ctx: AuthContext,
  rewardId: string,
  enabled: boolean,
): Promise<void> {
  const ref = getDb().collection(COLLECTIONS.rewardTemplates).doc(rewardId);
  const snap = await ref.get();
  if (!snap.exists) throw new NotFoundError(`Reward ${rewardId} not found.`);
  const data = snap.data() as RewardTemplate;
  // Load-then-authorize (§10) — `resourceMerchantId` comes from the loaded document, never from
  // caller input, so a cross-tenant `rewardId` correctly yields `TenantIsolationError` rather than
  // a generic permission denial that could be confused with "you're just missing this permission".
  requirePermission(ctx, PERMISSIONS.REWARD_MANAGE, data.merchantId);

  await ref.update({ enabled, updatedAt: FieldValue.serverTimestamp() });
  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: enabled ? "reward.enabled" : "reward.disabled",
    targetType: "rewardTemplate",
    targetId: rewardId,
    before: { enabled: data.enabled },
    after: { enabled },
  });
}

/** Every role that holds REWARD_REDEEM (Owner/Manager/Staff, all of them — §9) can list templates
 * — Staff legitimately needs to know what's redeemable to offer it to a customer, same precedent
 * as `listPointRules` reusing `POINTS_VIEW_HISTORY` in Phase 3. */
export async function listRewardTemplates(ctx: AuthContext): Promise<RewardTemplate[]> {
  requirePermission(ctx, PERMISSIONS.REWARD_REDEEM, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.rewardTemplates)
    .where("merchantId", "==", ctx.merchantId)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<RewardTemplate, "id">) }));
}

// --- Redeem / Use (Owner/Manager/Staff — REWARD_REDEEM) -------------------------------------

export interface RedeemRewardInput {
  membershipId: string;
  rewardTemplateId: string;
  branchId: string | null;
  visitSource: "STAFF_SCAN" | "STAFF_SEARCH";
  idempotencyKey: string;
}

export interface RedeemRewardResult {
  voucherId: string;
}

function assertRewardIsRedeemable(template: RewardTemplate, now: Date, branchId: string | null): void {
  if (!template.enabled) throw new ValidationError("This reward is not currently available.");
  if (template.startAt && template.startAt.toDate() > now) {
    throw new ValidationError("This reward is not available yet.");
  }
  if (template.endAt && template.endAt.toDate() < now) {
    throw new ValidationError("This reward is no longer available.");
  }
  if (template.stock !== null && template.stock <= 0) {
    throw new ValidationError("This reward is out of stock.");
  }
  if (!rewardAppliesToBranch(template, branchId)) {
    throw new ValidationError("This reward is not available at this branch.");
  }
}

/**
 * Redeem Flow (§13, idempotent + transactional): checks requiredPoints/stock/limitPerMember/
 * branchScope/dateRange, then in ONE transaction — spends points via FIFO (§12), decrements
 * stock, creates the `voucherInstance` (AVAILABLE), records a Visit, and writes the
 * `reward.redeemed` event. All reads (idempotency check, membership, template, limitPerMember
 * count, FIFO plan) happen before any write, per Firestore's transaction rules (the exact ordering
 * bug class found and fixed in Phase 3's Final Review).
 */
export async function redeemReward(ctx: AuthContext, input: RedeemRewardInput): Promise<RedeemRewardResult> {
  requirePermission(ctx, PERMISSIONS.REWARD_REDEEM, ctx.merchantId);
  if (input.branchId) requireBranchScope(ctx, input.branchId);

  const db = getDb();
  const now = new Date();

  const { voucherId, isReplay } = await db.runTransaction(async (tx) => {
    // ---- READS (every one of them, before any write below) ----
    await assertPointsEngineNotFrozenTx(tx, ctx.merchantId); // Emergency Control §37.2 — first read
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "reward.redeem", input.idempotencyKey);
    if (existing) return { voucherId: existing, isReplay: true };

    const membership = await loadMembershipForMerchantTx(tx, input.membershipId, ctx.merchantId);

    const templateRef = db.collection(COLLECTIONS.rewardTemplates).doc(input.rewardTemplateId);
    const templateSnap = await tx.get(templateRef);
    if (!templateSnap.exists) throw new NotFoundError(`Reward ${input.rewardTemplateId} not found.`);
    const template = { id: templateSnap.id, ...(templateSnap.data() as Omit<RewardTemplate, "id">) };
    if (template.merchantId !== ctx.merchantId) {
      throw new TenantIsolationError(
        `Staff of merchant ${ctx.merchantId} attempted to redeem a reward of merchant ${template.merchantId}.`,
      );
    }
    assertRewardIsRedeemable(template, now, input.branchId);

    if (template.limitPerMember !== null) {
      const redeemedSnap = await tx.get(
        db
          .collection(COLLECTIONS.voucherInstances)
          .where("merchantId", "==", ctx.merchantId)
          .where("membershipId", "==", input.membershipId)
          .where("rewardTemplateId", "==", input.rewardTemplateId),
      );
      if (redeemedSnap.size >= template.limitPerMember) {
        throw new ValidationError(
          `This member has already redeemed this reward the maximum number of times (${template.limitPerMember}).`,
        );
      }
    }

    const fifoAllocations = await planFifoConsumption(
      tx,
      ctx.merchantId,
      input.membershipId,
      template.requiredPoints,
    );

    // ---- WRITES (all of them, after every read above) ----
    const voucherRef = db.collection(COLLECTIONS.voucherInstances).doc();

    const ledgerRef = await writeLedgerEntry(tx, {
      merchantId: ctx.merchantId,
      membershipId: input.membershipId,
      branchId: input.branchId,
      type: "SPEND",
      delta: -template.requiredPoints,
      reason: `Redeemed reward: ${template.name}`,
      sourceType: "REWARD_REDEMPTION",
      sourceRefId: voucherRef.id,
      actorType: "staff",
      actorId: ctx.authUid,
      idempotencyKey: input.idempotencyKey,
    });

    applyFifoConsumption(tx, ctx.merchantId, input.membershipId, ledgerRef.id, fifoAllocations);

    tx.update(db.collection(COLLECTIONS.memberships).doc(input.membershipId), {
      pointsBalance: FieldValue.increment(-template.requiredPoints),
      pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
    });

    if (template.stock !== null) {
      tx.update(templateRef, { stock: FieldValue.increment(-1) });
    }

    tx.create(voucherRef, {
      merchantId: ctx.merchantId,
      membershipId: input.membershipId,
      rewardTemplateId: template.id,
      status: "AVAILABLE",
      sourceLedgerEntryId: ledgerRef.id,
      redeemedAt: FieldValue.serverTimestamp(),
      expiresAt: computeVoucherExpiresAt(template.voucherExpiryRule, now),
      usedAt: null,
      usedByStaffId: null,
      usedBranchId: null,
    });

    recordVisit(tx, {
      merchantId: ctx.merchantId,
      membershipId: input.membershipId,
      branchId: input.branchId,
      source: input.visitSource,
      countsAsVisit: true,
      relatedRefs: { pointsLedgerEntryId: ledgerRef.id, voucherInstanceId: voucherRef.id },
      createdBy: ctx.authUid,
      currentFirstVisitAt: membership.activityStats.firstVisitAt,
    });

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "reward.redeemed",
      membershipId: input.membershipId,
      payload: {
        voucherId: voucherRef.id,
        rewardTemplateId: template.id,
        ledgerEntryId: ledgerRef.id,
        requiredPoints: template.requiredPoints,
      },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "reward.redeem", input.idempotencyKey, voucherRef.id);

    return { voucherId: voucherRef.id, isReplay: false };
  });

  // §18 names "reward.redeemed" explicitly as an auditLogs action example (unlike Points, where
  // the ledger itself substitutes) — written outside the transaction, same best-effort-sequential
  // pattern every other `writeAuditLog` call site in this codebase uses. Only on a FRESH
  // redemption, never on an idempotent replay, so retries don't pollute the audit trail with
  // duplicate entries for what is really a single business event.
  if (!isReplay) {
    await writeAuditLog({
      merchantId: ctx.merchantId,
      actorType: "staff",
      actorId: ctx.authUid,
      action: "reward.redeemed",
      targetType: "voucherInstance",
      targetId: voucherId,
      after: { membershipId: input.membershipId, rewardTemplateId: input.rewardTemplateId },
    });
  }

  return { voucherId };
}

export interface ConfirmVoucherUseInput {
  voucherId: string;
  branchId: string | null;
  visitSource: "STAFF_SCAN" | "STAFF_SEARCH";
  idempotencyKey: string;
}

export interface ConfirmVoucherUseResult {
  voucherId: string;
}

function assertVoucherIsUsable(voucher: VoucherInstance, now: Date, sourceLedgerReversed: boolean): void {
  if (voucher.status === "USED") throw new ConflictError("This voucher has already been used.");
  if (voucher.status === "EXPIRED") throw new ValidationError("This voucher has expired.");
  // status === "AVAILABLE" from here — expiry is checked LAZILY here, at Use time, against the
  // stored `expiresAt` (locked Planning Review decision: no scheduled expiration sweep for V1).
  if (voucher.expiresAt && voucher.expiresAt.toDate() < now) {
    throw new ValidationError("This voucher has expired.");
  }
  if (sourceLedgerReversed) {
    // Locked Planning Review decision: the points that paid for this voucher were reversed after
    // the fact (Owner/Manager corrected a mistaken redemption) — reject Use rather than letting a
    // now-unpaid-for voucher still be honored. Detected via a plain read of `pointsLedger`, no
    // coupling added to `reversePoints`/`points/ledger-service.ts`.
    throw new ValidationError(
      "This voucher is no longer valid — the points that paid for it have been reversed.",
    );
  }
}

/**
 * Use Flow (§13, always a separate step from Redeem): validates (merchant/branch/expiry/status/
 * reversed-source), then sets `status=USED` + writes the `reward.used` event, in one transaction.
 */
export async function confirmVoucherUse(ctx: AuthContext, input: ConfirmVoucherUseInput): Promise<ConfirmVoucherUseResult> {
  requirePermission(ctx, PERMISSIONS.REWARD_REDEEM, ctx.merchantId);
  if (input.branchId) requireBranchScope(ctx, input.branchId);

  const db = getDb();
  const now = new Date();

  const { voucherId, isReplay } = await db.runTransaction(async (tx) => {
    // ---- READS ----
    const existing = await checkIdempotencyKey(tx, ctx.merchantId, "reward.use", input.idempotencyKey);
    if (existing) return { voucherId: existing, isReplay: true };

    const voucherRef = db.collection(COLLECTIONS.voucherInstances).doc(input.voucherId);
    const voucherSnap = await tx.get(voucherRef);
    if (!voucherSnap.exists) throw new NotFoundError(`Voucher ${input.voucherId} not found.`);
    const voucher = { id: voucherSnap.id, ...(voucherSnap.data() as Omit<VoucherInstance, "id">) };
    if (voucher.merchantId !== ctx.merchantId) {
      throw new TenantIsolationError(
        `Staff of merchant ${ctx.merchantId} attempted to use a voucher of merchant ${voucher.merchantId}.`,
      );
    }

    const sourceLedgerSnap = await tx.get(
      db.collection(COLLECTIONS.pointsLedger).doc(voucher.sourceLedgerEntryId),
    );
    const sourceLedgerReversed =
      sourceLedgerSnap.exists && Boolean((sourceLedgerSnap.data() as { reversedBy?: string }).reversedBy);

    // §15 Activity Stats Maintenance (Phase 8, Locked): this flow never loaded the membership
    // document before (only the voucher, which carries `membershipId`) — `recordVisit` needs its
    // current `firstVisitAt` to decide whether to set it, and that read must happen here, in the
    // READS phase, never inside `recordVisit` itself (called after writes below).
    const membershipSnap = await tx.get(db.collection(COLLECTIONS.memberships).doc(voucher.membershipId));
    if (!membershipSnap.exists) throw new NotFoundError(`Membership ${voucher.membershipId} not found.`);
    const currentFirstVisitAt = (membershipSnap.data() as MembershipRecord).activityStats.firstVisitAt;

    assertVoucherIsUsable(voucher, now, sourceLedgerReversed);

    // ---- WRITES ----
    tx.update(voucherRef, {
      status: "USED",
      usedAt: FieldValue.serverTimestamp(),
      usedByStaffId: ctx.authUid,
      usedBranchId: input.branchId,
    });

    recordVisit(tx, {
      merchantId: ctx.merchantId,
      membershipId: voucher.membershipId,
      branchId: input.branchId,
      source: input.visitSource,
      countsAsVisit: true,
      relatedRefs: { voucherInstanceId: voucher.id },
      createdBy: ctx.authUid,
      currentFirstVisitAt,
    });

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "reward.used",
      membershipId: voucher.membershipId,
      payload: { voucherId: voucher.id, rewardTemplateId: voucher.rewardTemplateId },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "reward.use", input.idempotencyKey, voucher.id);
    return { voucherId: voucher.id, isReplay: false };
  });

  if (!isReplay) {
    await writeAuditLog({
      merchantId: ctx.merchantId,
      actorType: "staff",
      actorId: ctx.authUid,
      action: "reward.used",
      targetType: "voucherInstance",
      targetId: voucherId,
    });
  }

  return { voucherId };
}

/** The actual query — reused by both the staff-facing `getRewardHistory` (permission-gated) and
 * the customer-portal service (authorized differently: by the caller already having resolved
 * `membershipId` from the customer's own verified identity, never a client-supplied value). One
 * implementation of "how do we find this membership's vouchers", two authorization entry points —
 * matching the same pattern `resolveOrCreateLineMembership` already established for customer- vs
 * staff-facing membership access (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่"). */
export async function listVoucherInstancesForMembership(
  merchantId: string,
  membershipId: string,
): Promise<VoucherInstance[]> {
  const snap = await getDb()
    .collection(COLLECTIONS.voucherInstances)
    .where("merchantId", "==", merchantId)
    .where("membershipId", "==", membershipId)
    .orderBy("redeemedAt", "desc")
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<VoucherInstance, "id">) }));
}

/** Reward History (§33) — parallel to `getPointsHistory` in Phase 3. Every role holding
 * REWARD_REDEEM can view it (same reasoning as `listRewardTemplates`). */
export async function getRewardHistory(ctx: AuthContext, membershipId: string): Promise<VoucherInstance[]> {
  requirePermission(ctx, PERMISSIONS.REWARD_REDEEM, ctx.merchantId);
  await getMembership(ctx, membershipId); // load-then-authorize tenant check (§10); result unused
  return listVoucherInstancesForMembership(ctx.merchantId, membershipId);
}
