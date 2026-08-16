import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { writeEvent } from "@/modules/event/service";
import { getMembership, loadMembershipForMerchantTx } from "@/modules/membership/service";
import type { Segment } from "@/modules/membership/types";
import { getMerchant } from "@/modules/merchant/service";
import { recordVisit } from "@/modules/points/ledger-service";
import { requireBranchScope, requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type {
  CouponConditions,
  CouponExpiryRule,
  CouponInstance,
  CouponIssuedVia,
  CouponTemplate,
  CouponType,
} from "@/modules/coupon/types";
import { ConflictError, NotFoundError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";
import { branchesCollection, COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { checkIdempotencyKey, recordIdempotencyKey } from "@/modules/shared/idempotency";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Coupon Template CRUD + Instance Generation (Issue) + Redemption flow (FINAL-ARCHITECTURE.md
 * §14) — Phase 5.
 *
 * Terminology (do not confuse with Reward, §13): **Issue** = get the coupon, no points spent
 * (parallel to Reward's "Redeem"); **Redeem** = consume it at the counter (parallel to Reward's
 * "Use") — confirmed by §17's event list (`coupon.issued`, `coupon.redeemed`, no `coupon.used`).
 *
 * Coupon never touches `points/ledger-service.ts`'s FIFO/ledger primitives at all — §14: "ไม่ต้อง
 * แลกด้วยแต้มเสมอไป", and §5's `couponInstances` schema has no ledger-entry-reference field. Only
 * `recordVisit` is reused from that module (Visit isn't a separately documented module — same
 * reuse precedent Reward already established in Phase 4).
 *
 * RBAC boundary that matters most here (flagged explicitly in the Phase 5 Planning Review):
 * **Issuing** a new coupon instance (Manual/Segment distribution) requires `COUPON_MANAGE`
 * (Owner/Manager only) — NOT `COUPON_REDEEM`, which Staff also holds but is scoped to the
 * consume-at-the-counter step only. Gating issuance behind `COUPON_REDEEM` would let Staff mint
 * free coupons for themselves/associates with no oversight — a real fraud vector.
 *
 * Locked Phase 5 Architecture Decisions (docs/architecture/FINAL-ARCHITECTURE.md §14), implemented
 * literally, not reinterpreted:
 * - **Usage Limit**: 1 `couponInstances/{id}` = redeem/use once. No `maxUses`/`remainingUses`
 *   field, no multi-use. Redemption is one atomic, idempotent Firestore transaction; a `USED`
 *   instance can never be redeemed again.
 * - **Coupon Expiration**: lazy validation only — `expiresAt` is checked against `serverNow`
 *   inside the same transaction as every claim/redeem operation. No scheduled sweep Cloud
 *   Function in Phase 5 (deferred, per §32's annotation).
 */

const VALID_TYPES: readonly CouponType[] = [
  "PERCENTAGE_DISCOUNT",
  "FIXED_DISCOUNT",
  "FREE_PRODUCT",
  "FREE_SERVICE",
  "BUY_X_GET_Y",
  "PRIVILEGE",
  "CUSTOM",
];

function validateCouponExpiryRule(rule: CouponExpiryRule): void {
  switch (rule.type) {
    case "NEVER":
      return;
    case "DAYS_AFTER_ISSUANCE":
      if (!Number.isInteger(rule.days) || rule.days <= 0) {
        throw new ValidationError("expiryRule.days must be a positive integer.");
      }
      return;
    case "FIXED_DATE":
      if (!rule.date) throw new ValidationError("expiryRule.date is required for FIXED_DATE.");
      return;
  }
}

function computeCouponExpiresAt(rule: CouponExpiryRule, issuedAt: Date): Timestamp | null {
  switch (rule.type) {
    case "NEVER":
      return null;
    case "DAYS_AFTER_ISSUANCE":
      return Timestamp.fromMillis(issuedAt.getTime() + rule.days * 24 * 60 * 60 * 1000);
    case "FIXED_DATE":
      return rule.date;
  }
}

function validateDayOfWeekList(days: number[]): void {
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) {
      throw new ValidationError("validDaysOfWeek entries must be integers 0 (Sunday) to 6 (Saturday).");
    }
  }
}

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validateTimeRange(range: { start: string; end: string } | null): void {
  if (!range) return;
  if (!TIME_PATTERN.test(range.start) || !TIME_PATTERN.test(range.end)) {
    throw new ValidationError("validTimeRange.start/end must be in HH:mm 24-hour format.");
  }
  if (range.end <= range.start) {
    // Simplest interpretation of an unspecified edge case (§14 never describes a midnight-wrapping
    // range) — same-day window only, matching the "never guess a business rule" posture already
    // used for SEASON_BASED (§12)/coupon FIXED_DATE-via-API elsewhere in this codebase.
    throw new ValidationError("validTimeRange.end must be after validTimeRange.start (same-day range only).");
  }
}

function couponAppliesToBranch(branchScope: string[], branchId: string | null): boolean {
  if (branchScope.length === 0) return true; // empty = all branches (§14, same convention as §11/§13)
  return branchId !== null && branchScope.includes(branchId);
}

/** "Valid Days/Hours" (§14) — evaluated in the MERCHANT's own configured timezone (never
 * hard-coded to Thai time, per CLAUDE.md §0), using the native `Intl` API — no new dependency.
 * Neither Points Rules' MULTIPLIER (§11, scaffolded but never wired into `evaluatePointRules`) nor
 * anything else in this codebase evaluates `dayOfWeek`/`timeRange` yet, so this is new logic, not
 * reused from an existing precedent. */
function isWithinValidDaysAndHours(conditions: CouponConditions, now: Date, timezone: string): boolean {
  if (conditions.validDaysOfWeek.length === 0 && !conditions.validTimeRange) return true;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayOfWeek = weekdayMap[weekdayStr] ?? 0;
  const hhmm = `${hour}:${minute}`;

  if (conditions.validDaysOfWeek.length > 0 && !conditions.validDaysOfWeek.includes(dayOfWeek)) {
    return false;
  }
  if (conditions.validTimeRange && (hhmm < conditions.validTimeRange.start || hhmm > conditions.validTimeRange.end)) {
    return false;
  }
  return true;
}

// --- Coupon Template CRUD (Owner/Manager — COUPON_MANAGE) -----------------------------------

export interface CreateCouponTemplateInput {
  name: string;
  description?: string;
  type: CouponType;
  minimumAmount?: number | null;
  maximumDiscount?: number | null;
  validDaysOfWeek?: number[];
  validTimeRange?: { start: string; end: string } | null;
  branchScope?: string[];
  totalLimit?: number | null;
  limitPerMember?: number | null;
  startAt?: Date | null;
  endAt?: Date | null;
  expiryRule?: CouponExpiryRule;
  stackable?: boolean;
}

export async function createCouponTemplate(ctx: AuthContext, input: CreateCouponTemplateInput): Promise<string> {
  requirePermission(ctx, PERMISSIONS.COUPON_MANAGE, ctx.merchantId);
  if (input.name.trim().length === 0) throw new ValidationError("name must not be empty.");
  if (!VALID_TYPES.includes(input.type)) throw new ValidationError(`Invalid coupon type: ${input.type}`);

  if (input.totalLimit !== undefined && input.totalLimit !== null) {
    if (!Number.isInteger(input.totalLimit) || input.totalLimit < 0) {
      throw new ValidationError("totalLimit must be a non-negative integer, or null for unlimited.");
    }
  }
  if (input.limitPerMember !== undefined && input.limitPerMember !== null) {
    if (!Number.isInteger(input.limitPerMember) || input.limitPerMember <= 0) {
      throw new ValidationError("limitPerMember must be a positive integer, or null for unlimited.");
    }
  }
  const validDaysOfWeek = input.validDaysOfWeek ?? [];
  validateDayOfWeekList(validDaysOfWeek);
  const validTimeRange = input.validTimeRange ?? null;
  validateTimeRange(validTimeRange);

  const expiryRule = input.expiryRule ?? { type: "NEVER" as const };
  validateCouponExpiryRule(expiryRule);

  // §14 "Start/End" (template active window, checked at ISSUANCE time — see `assertCouponIsIssuable`).
  if (input.startAt && input.endAt && input.endAt.getTime() <= input.startAt.getTime()) {
    throw new ValidationError("endAt must be after startAt.");
  }

  const branchScope = input.branchScope ?? [];
  if (branchScope.length > 0) {
    // Same load-then-validate pattern already applied to `rewardTemplates.branchScope` (Phase 4
    // Final Review blocker fix) — every id must be a REAL branch of the CALLER'S OWN merchant.
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

  const conditions: CouponConditions = {
    minimumAmount: input.minimumAmount ?? null,
    maximumDiscount: input.maximumDiscount ?? null,
    validDaysOfWeek,
    validTimeRange,
    branchScope,
    totalLimit: input.totalLimit ?? null,
    limitPerMember: input.limitPerMember ?? null,
    startAt: input.startAt ? Timestamp.fromDate(input.startAt) : null,
    endAt: input.endAt ? Timestamp.fromDate(input.endAt) : null,
    expiryRule,
    stackable: input.stackable ?? false,
  };

  const ref = getDb().collection(COLLECTIONS.couponTemplates).doc();
  await ref.set({
    merchantId: ctx.merchantId,
    name: input.name,
    description: input.description ?? "",
    type: input.type,
    enabled: true,
    conditions,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "coupon.created",
    targetType: "couponTemplate",
    targetId: ref.id,
    after: { name: input.name, type: input.type },
  });

  return ref.id;
}

export async function setCouponTemplateEnabled(ctx: AuthContext, couponId: string, enabled: boolean): Promise<void> {
  const ref = getDb().collection(COLLECTIONS.couponTemplates).doc(couponId);
  const snap = await ref.get();
  if (!snap.exists) throw new NotFoundError(`Coupon ${couponId} not found.`);
  const data = snap.data() as CouponTemplate;
  // Load-then-authorize (§10) — `resourceMerchantId` comes from the loaded document, never from
  // caller input, so a cross-tenant `couponId` correctly yields `TenantIsolationError`.
  requirePermission(ctx, PERMISSIONS.COUPON_MANAGE, data.merchantId);

  await ref.update({ enabled, updatedAt: FieldValue.serverTimestamp() });
  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: enabled ? "coupon.enabled" : "coupon.disabled",
    targetType: "couponTemplate",
    targetId: couponId,
    before: { enabled: data.enabled },
    after: { enabled },
  });
}

/** Every role holding COUPON_REDEEM (Owner/Manager/Staff, all of them — §9) can list templates —
 * Staff needs to know what's available to explain to/redeem for a customer, same precedent as
 * `listRewardTemplates` (Phase 4). */
export async function listCouponTemplates(ctx: AuthContext): Promise<CouponTemplate[]> {
  requirePermission(ctx, PERMISSIONS.COUPON_REDEEM, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.couponTemplates)
    .where("merchantId", "==", ctx.merchantId)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<CouponTemplate, "id">) }));
}

// --- Instance Generation (Issue) — Owner/Manager only, COUPON_MANAGE ------------------------

function assertCouponIsIssuable(template: CouponTemplate, now: Date): void {
  if (!template.enabled) throw new ValidationError("This coupon is not currently available.");
  const { startAt, endAt } = template.conditions;
  if (startAt && startAt.toDate() > now) throw new ValidationError("This coupon is not available yet.");
  if (endAt && endAt.toDate() < now) throw new ValidationError("This coupon is no longer available.");
}

/** Exported (Phase 6) — the promotion-automation executor's ISSUE_COUPON action calls this
 * directly (not `issueCouponManual`, which hard-codes `issuedVia:'MANUAL'`) so an automation-
 * driven issuance is correctly traceable via one of the already-modeled non-MANUAL `issuedVia`
 * values (e.g. `'PROMOTION'`/`'CAMPAIGN'`), and correctly sets `countsAsVisit:false` (§15 — a
 * system-triggered issuance is not a staff-initiated counter interaction, same as Segment). */
export interface IssueCouponInstanceParams {
  membershipId: string;
  couponTemplateId: string;
  branchId: string | null;
  issuedVia: CouponIssuedVia;
  visitSource?: "STAFF_SCAN" | "STAFF_SEARCH";
  /** §15: "ห้าม assume ว่า points.earned ทุกครั้ง = การมาร้าน" — the same principle applies here:
   * a bulk/automated Segment blast is NOT a staff-initiated counter interaction, so it must not
   * create a Visit, unlike a Manual (in-person) issuance. */
  countsAsVisit: boolean;
  idempotencyKey: string;
}

/** Shared core for both `issueCouponManual` and `issueCouponToSegment` — one implementation of
 * "create a coupon instance" (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่"), not duplicated per
 * distribution channel. All reads (idempotency check, membership, template, Total/Per-Member
 * Limit counts) happen before any write, per Firestore's transaction rules — the exact ordering
 * bug class found and fixed in Phase 3/4's Final Reviews. */
export async function issueCouponInstance(
  ctx: AuthContext,
  params: IssueCouponInstanceParams,
): Promise<{ instanceId: string; code: string; isReplay: boolean }> {
  const db = getDb();
  const now = new Date();

  return db.runTransaction(async (tx) => {
    // ---- READS ----
    const existingId = await checkIdempotencyKey(tx, ctx.merchantId, "coupon.issue", params.idempotencyKey);
    if (existingId) {
      const existingSnap = await tx.get(db.collection(COLLECTIONS.couponInstances).doc(existingId));
      const code = (existingSnap.data() as CouponInstance | undefined)?.code ?? "";
      return { instanceId: existingId, code, isReplay: true };
    }

    const membership = await loadMembershipForMerchantTx(tx, params.membershipId, ctx.merchantId);

    const templateRef = db.collection(COLLECTIONS.couponTemplates).doc(params.couponTemplateId);
    const templateSnap = await tx.get(templateRef);
    if (!templateSnap.exists) throw new NotFoundError(`Coupon ${params.couponTemplateId} not found.`);
    const template = { id: templateSnap.id, ...(templateSnap.data() as Omit<CouponTemplate, "id">) };
    if (template.merchantId !== ctx.merchantId) {
      throw new TenantIsolationError(
        `Staff of merchant ${ctx.merchantId} attempted to issue a coupon of merchant ${template.merchantId}.`,
      );
    }
    assertCouponIsIssuable(template, now);

    const conditions = template.conditions;
    if (conditions.totalLimit !== null) {
      const totalSnap = await tx.get(
        db
          .collection(COLLECTIONS.couponInstances)
          .where("merchantId", "==", ctx.merchantId)
          .where("couponTemplateId", "==", params.couponTemplateId),
      );
      if (totalSnap.size >= conditions.totalLimit) {
        throw new ValidationError(`This coupon has reached its total issuance limit (${conditions.totalLimit}).`);
      }
    }
    if (conditions.limitPerMember !== null) {
      const memberSnap = await tx.get(
        db
          .collection(COLLECTIONS.couponInstances)
          .where("merchantId", "==", ctx.merchantId)
          .where("membershipId", "==", params.membershipId)
          .where("couponTemplateId", "==", params.couponTemplateId),
      );
      if (memberSnap.size >= conditions.limitPerMember) {
        throw new ValidationError(
          `This member has already received this coupon the maximum number of times (${conditions.limitPerMember}).`,
        );
      }
    }

    // ---- WRITES ----
    const instanceRef = db.collection(COLLECTIONS.couponInstances).doc();
    // Short, human-typeable code derived from the doc id — same precedent as Phase 3's
    // `generateMemberCode` (`membershipId.slice(0,8).toUpperCase()`), same accepted low-collision
    // risk at this platform's scale (lookup is always merchantId-scoped too).
    const code = instanceRef.id.slice(0, 8).toUpperCase();

    tx.create(instanceRef, {
      merchantId: ctx.merchantId,
      membershipId: params.membershipId,
      couponTemplateId: template.id,
      issuedVia: params.issuedVia,
      code,
      status: "AVAILABLE",
      issuedAt: FieldValue.serverTimestamp(),
      expiresAt: computeCouponExpiresAt(conditions.expiryRule, now),
      usedAt: null,
      usedByStaffId: null,
      usedBranchId: null,
    });

    if (params.countsAsVisit) {
      recordVisit(tx, {
        merchantId: ctx.merchantId,
        membershipId: params.membershipId,
        branchId: params.branchId,
        source: params.visitSource ?? "STAFF_SEARCH",
        countsAsVisit: true,
        relatedRefs: { couponInstanceId: instanceRef.id },
        createdBy: ctx.authUid,
      });
    }

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "coupon.issued",
      membershipId: params.membershipId,
      payload: { instanceId: instanceRef.id, couponTemplateId: template.id, issuedVia: params.issuedVia },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "coupon.issue", params.idempotencyKey, instanceRef.id);

    void membership; // loaded for tenant-check + transaction-read-before-write ordering only
    return { instanceId: instanceRef.id, code, isReplay: false };
  });
}

export interface IssueCouponManualInput {
  membershipId: string;
  couponTemplateId: string;
  branchId: string | null;
  visitSource: "STAFF_SCAN" | "STAFF_SEARCH";
  idempotencyKey: string;
}

export interface IssueCouponResult {
  instanceId: string;
  code: string;
}

/** Manual distribution (§14, §33 "manual/segment ก่อน") — Owner/Manager issues ONE coupon
 * instance to ONE specific member, found via the same Staff Search/Scan flow as Phase 3/4. */
export async function issueCouponManual(ctx: AuthContext, input: IssueCouponManualInput): Promise<IssueCouponResult> {
  requirePermission(ctx, PERMISSIONS.COUPON_MANAGE, ctx.merchantId);
  if (input.branchId) requireBranchScope(ctx, input.branchId);

  const result = await issueCouponInstance(ctx, {
    membershipId: input.membershipId,
    couponTemplateId: input.couponTemplateId,
    branchId: input.branchId,
    issuedVia: "MANUAL",
    visitSource: input.visitSource,
    countsAsVisit: true,
    idempotencyKey: input.idempotencyKey,
  });

  if (!result.isReplay) {
    await writeAuditLog({
      merchantId: ctx.merchantId,
      actorType: "staff",
      actorId: ctx.authUid,
      action: "coupon.issued",
      targetType: "couponInstance",
      targetId: result.instanceId,
      after: { membershipId: input.membershipId, couponTemplateId: input.couponTemplateId, issuedVia: "MANUAL" },
    });
  }

  return { instanceId: result.instanceId, code: result.code };
}

export interface IssueCouponToSegmentInput {
  couponTemplateId: string;
  targetSegment: Segment;
  idempotencyKey: string;
}

export interface IssueCouponToSegmentResult {
  issuedCount: number;
  skippedCount: number;
  instanceIds: string[];
}

/**
 * Segment distribution (§14, §33 "manual/segment ก่อน") — Owner/Manager issues one instance to
 * every member of this merchant currently in `targetSegment`. Not a Visit (bulk/automated, §15).
 * Each member gets a deterministic per-member idempotency key derived from the caller's own
 * `idempotencyKey` — retrying the WHOLE batch call never double-issues to anyone, without needing
 * a separate top-level lock (§26, §27).
 *
 * KNOWN LIMITATION (documented in the Phase 5 Planning Review, not a defect of this function):
 * `membership.activityStats.segment` is never recalculated by any scheduled job anywhere in this
 * codebase (§15's "Scheduled Daily Batch Job" was never built in Phase 1–4) — every membership is
 * permanently `"NEW"` today. This query is correct against whatever segment values exist and will
 * become meaningful the moment a later phase adds that job, with no rework needed here.
 */
export async function issueCouponToSegment(
  ctx: AuthContext,
  input: IssueCouponToSegmentInput,
): Promise<IssueCouponToSegmentResult> {
  requirePermission(ctx, PERMISSIONS.COUPON_MANAGE, ctx.merchantId);

  const db = getDb();
  const membershipsSnap = await db
    .collection(COLLECTIONS.memberships)
    .where("merchantId", "==", ctx.merchantId)
    .where("activityStats.segment", "==", input.targetSegment)
    .get();

  const instanceIds: string[] = [];
  let skippedCount = 0;

  // Sequential, not parallel — each member's Total-Limit check must see every prior member's
  // already-committed write in this same batch, or the limit could be oversold across the batch.
  for (const membershipDoc of membershipsSnap.docs) {
    try {
      const result = await issueCouponInstance(ctx, {
        membershipId: membershipDoc.id,
        couponTemplateId: input.couponTemplateId,
        branchId: null,
        issuedVia: "SEGMENT",
        countsAsVisit: false,
        idempotencyKey: `${input.idempotencyKey}:${membershipDoc.id}`,
      });
      instanceIds.push(result.instanceId);
    } catch (err) {
      // A per-member limit/eligibility failure (ValidationError) skips just that member and
      // continues the batch — a cross-tenant/missing-template failure aborts the whole call, the
      // same distinction `redeemReward`-adjacent code makes elsewhere in this codebase.
      if (err instanceof ValidationError) {
        skippedCount += 1;
        continue;
      }
      throw err;
    }
  }

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "coupon.issued_to_segment",
    targetType: "couponTemplate",
    targetId: input.couponTemplateId,
    after: { targetSegment: input.targetSegment, issuedCount: instanceIds.length, skippedCount },
  });

  return { issuedCount: instanceIds.length, skippedCount, instanceIds };
}

// --- Redemption (Owner/Manager/Staff — COUPON_REDEEM) ----------------------------------------

export interface RedeemCouponInput {
  /** §14: "Coupon Code (ลูกค้ากรอกโค้ดเอง) และ QR-only ต้องรองรับทั้งคู่" — both formats resolve
   * through this SAME field: a scanned QR encodes the coupon's `code` (never the raw Firestore
   * instance id, same reasoning as `points/qr.ts`), and a staff-typed code is the same string. */
  code: string;
  branchId: string | null;
  visitSource: "STAFF_SCAN" | "STAFF_SEARCH";
  idempotencyKey: string;
}

export interface RedeemCouponResult {
  instanceId: string;
  membershipId: string;
}

function assertCouponIsRedeemable(
  instance: CouponInstance,
  template: CouponTemplate,
  now: Date,
  branchId: string | null,
  timezone: string,
): void {
  if (instance.status === "USED") throw new ConflictError("This coupon has already been redeemed.");
  if (instance.status === "EXPIRED") throw new ValidationError("This coupon has expired.");
  // Locked Phase 5 decision: LAZY expiry check only, `<=` (not `<`) — an instance whose
  // `expiresAt` equals `serverNow` exactly is treated as already expired.
  if (instance.expiresAt && instance.expiresAt.toDate().getTime() <= now.getTime()) {
    throw new ValidationError("This coupon has expired.");
  }
  if (!couponAppliesToBranch(template.conditions.branchScope, branchId)) {
    throw new ValidationError("This coupon is not valid at this branch.");
  }
  if (!isWithinValidDaysAndHours(template.conditions, now, timezone)) {
    throw new ValidationError("This coupon is not valid at this day or time.");
  }
}

/**
 * Redemption Flow (§14, always a separate step from Issue, "สอง-step confirm เหมือน Reward"):
 * validates (status/expiry/branch/valid-days-hours), then sets `status=USED` + writes the
 * `coupon.redeemed` event, in one atomic, idempotent transaction. `minimumAmount`/
 * `maximumDiscount`/`stackable` are never enforced here — §14 explicitly keeps them as staff-
 * facing metadata only, until real POS integration exists (out of V1 scope).
 */
export async function redeemCoupon(ctx: AuthContext, input: RedeemCouponInput): Promise<RedeemCouponResult> {
  requirePermission(ctx, PERMISSIONS.COUPON_REDEEM, ctx.merchantId);
  if (input.branchId) requireBranchScope(ctx, input.branchId);

  const db = getDb();
  const now = new Date();
  const normalizedCode = input.code.trim().toUpperCase();
  const merchant = await getMerchant(ctx, ctx.merchantId);

  const result = await db.runTransaction(async (tx) => {
    // ---- READS ----
    const existingId = await checkIdempotencyKey(tx, ctx.merchantId, "coupon.redeem", input.idempotencyKey);
    if (existingId) {
      const existingSnap = await tx.get(db.collection(COLLECTIONS.couponInstances).doc(existingId));
      const membershipId = (existingSnap.data() as CouponInstance | undefined)?.membershipId ?? "";
      return { instanceId: existingId, membershipId, isReplay: true };
    }

    // Query by code alone (not merchantId-scoped in the query itself), then explicitly check
    // ownership and reject with `NotFoundError` on mismatch — same anti-IDOR pattern as
    // `getMembershipByCode` (§10, §26): never confirm a code's existence under another merchant.
    const instanceQuerySnap = await tx.get(
      db.collection(COLLECTIONS.couponInstances).where("code", "==", normalizedCode).limit(1),
    );
    if (instanceQuerySnap.empty) throw new NotFoundError(`No coupon found for code ${input.code}.`);
    const instanceDoc = instanceQuerySnap.docs[0];
    const instance = { id: instanceDoc.id, ...(instanceDoc.data() as Omit<CouponInstance, "id">) };
    if (instance.merchantId !== ctx.merchantId) {
      throw new NotFoundError(`No coupon found for code ${input.code}.`);
    }

    const templateSnap = await tx.get(db.collection(COLLECTIONS.couponTemplates).doc(instance.couponTemplateId));
    if (!templateSnap.exists) throw new NotFoundError(`Coupon template for ${input.code} not found.`);
    const template = { id: templateSnap.id, ...(templateSnap.data() as Omit<CouponTemplate, "id">) };

    assertCouponIsRedeemable(instance, template, now, input.branchId, merchant.timezone);

    // ---- WRITES ----
    tx.update(instanceDoc.ref, {
      status: "USED",
      usedAt: FieldValue.serverTimestamp(),
      usedByStaffId: ctx.authUid,
      usedBranchId: input.branchId,
    });

    recordVisit(tx, {
      merchantId: ctx.merchantId,
      membershipId: instance.membershipId,
      branchId: input.branchId,
      source: input.visitSource,
      countsAsVisit: true,
      relatedRefs: { couponInstanceId: instance.id },
      createdBy: ctx.authUid,
    });

    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "coupon.redeemed",
      membershipId: instance.membershipId,
      payload: { instanceId: instance.id, couponTemplateId: instance.couponTemplateId },
    });

    recordIdempotencyKey(tx, ctx.merchantId, "coupon.redeem", input.idempotencyKey, instance.id);
    return { instanceId: instance.id, membershipId: instance.membershipId, isReplay: false };
  });

  if (!result.isReplay) {
    await writeAuditLog({
      merchantId: ctx.merchantId,
      actorType: "staff",
      actorId: ctx.authUid,
      action: "coupon.redeemed",
      targetType: "couponInstance",
      targetId: result.instanceId,
      after: { membershipId: result.membershipId },
    });
  }

  return { instanceId: result.instanceId, membershipId: result.membershipId };
}

/** Coupon History — parallel to `getRewardHistory` (Phase 4). Every role holding COUPON_REDEEM
 * can view it (same reasoning as `listCouponTemplates`). */
export async function getCouponHistory(ctx: AuthContext, membershipId: string): Promise<CouponInstance[]> {
  requirePermission(ctx, PERMISSIONS.COUPON_REDEEM, ctx.merchantId);
  await getMembership(ctx, membershipId); // load-then-authorize tenant check (§10); result unused

  const snap = await getDb()
    .collection(COLLECTIONS.couponInstances)
    .where("merchantId", "==", ctx.merchantId)
    .where("membershipId", "==", membershipId)
    .orderBy("issuedAt", "desc")
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<CouponInstance, "id">) }));
}
