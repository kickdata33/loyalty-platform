import { createHash } from "node:crypto";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { issueCouponInstance } from "@/modules/coupon/service";
import { writeEvent } from "@/modules/event/service";
import type { DomainEventType } from "@/modules/event/types";
import { loadMembershipForMerchantTx } from "@/modules/membership/service";
import type { MembershipRecord } from "@/modules/membership/types";
import { computeExpiresAt, createLot, writeLedgerEntry } from "@/modules/points/ledger-service";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import { redeemReward } from "@/modules/reward/service";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";
import type {
  Automation,
  AutomationAction,
  AutomationActionType,
  AutomationCondition,
  AutomationLimits,
  AutomationTrigger,
  AutomationTriggerType,
} from "@/modules/promotion-automation/types";
import { DEFERRED_ACTION_TYPES, DEFERRED_TRIGGER_TYPES } from "@/modules/promotion-automation/types";
import { sendNotification } from "@/modules/notification/service";
import type { NotificationTemplateType } from "@/modules/notification/types";

/**
 * Promotion/Automation Engine (FINAL-ARCHITECTURE.md §16, §17) — Phase 6.
 *
 * "Automation คือ Engine เดียว, Promotion คือหน้าตาเท่านั้น" — this file is the ONLY place
 * `automations`/`automationActionExecutions` are written. Both the raw Automation builder UI and
 * the simplified Promotion wizard UI call the exact same `createAutomation`/`updateAutomation`
 * below (§16: "ทั้งสอง UI แก้ document เดียวกัน").
 *
 * Locked deferrals (do NOT reinterpret — FINAL-ARCHITECTURE.md §16, "CHANGE_TIER — Deferred for
 * Phase 6" / "BIRTHDAY — Deferred for Phase 6"): `trigger.type==='BIRTHDAY'` and any
 * `actions[].type==='CHANGE_TIER'` are rejected at create/update time with a deterministic
 * `ValidationError` — never silently dropped, never executed.
 */

const VALID_TRIGGER_TYPES: readonly AutomationTriggerType[] = [
  "MEMBER_CREATED",
  "BIRTHDAY",
  "POINTS_REACHED",
  "INACTIVE_DAYS",
  "COUPON_EXPIRING",
  "COUPON_REDEEMED",
  "REWARD_REDEEMED",
  "SCHEDULE",
];

const VALID_ACTION_TYPES: readonly AutomationActionType[] = [
  "ADD_POINTS",
  "ISSUE_COUPON",
  "ISSUE_REWARD",
  "ADD_TAG",
  "CHANGE_TIER",
  "SEND_NOTIFICATION",
  "NOTIFY_OWNER",
];

/** Real-time trigger types are mapped 1:1 from the `DomainEventType` that fires them — an event
 * whose type isn't in this map can never drive a real-time automation (it's either not modeled
 * yet, or scheduled-only, per `SCHEDULED_TRIGGER_TYPES`/the locked BIRTHDAY deferral). */
const EVENT_TYPE_TO_TRIGGER_TYPE: Partial<Record<DomainEventType, AutomationTriggerType>> = {
  "membership.created": "MEMBER_CREATED",
  "points.earned": "POINTS_REACHED",
  "points.adjusted": "POINTS_REACHED",
  "coupon.redeemed": "COUPON_REDEEMED",
  "reward.redeemed": "REWARD_REDEEMED",
};

function validateTriggerAndActions(trigger: AutomationTrigger, actions: AutomationAction[]): void {
  if (!VALID_TRIGGER_TYPES.includes(trigger.type)) {
    throw new ValidationError(`Invalid trigger type: ${trigger.type}`);
  }
  if (DEFERRED_TRIGGER_TYPES.includes(trigger.type)) {
    // Locked Phase 6 decision — BIRTHDAY is modeled for forward compatibility only.
    throw new ValidationError(
      `Trigger type '${trigger.type}' is not available yet — no birth-date field exists in this ` +
        "platform's schema (FINAL-ARCHITECTURE.md §16 'BIRTHDAY — Deferred for Phase 6').",
    );
  }
  if (actions.length === 0) throw new ValidationError("At least one action is required.");
  for (const action of actions) {
    if (!VALID_ACTION_TYPES.includes(action.type)) {
      throw new ValidationError(`Invalid action type: ${action.type}`);
    }
    if (DEFERRED_ACTION_TYPES.includes(action.type)) {
      // Locked Phase 6 decision — CHANGE_TIER is modeled for forward compatibility only.
      throw new ValidationError(
        `Action type '${action.type}' is not available yet — no Membership Tier system exists in ` +
          "this platform (FINAL-ARCHITECTURE.md §16 'CHANGE_TIER — Deferred for Phase 6').",
      );
    }
  }
}

function validateLimits(limits: AutomationLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (value !== null && (!Number.isFinite(value as number) || (value as number) < 0)) {
      throw new ValidationError(`limits.${key} must be a non-negative number, or null for unlimited.`);
    }
  }
}

// --- CRUD (Owner/Manager — AUTOMATION_MANAGE) -------------------------------------------------

export interface UpsertAutomationInput {
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  limits: AutomationLimits;
  presentedAs: "AUTOMATION" | "PROMOTION";
  marketing?: Automation["marketing"];
}

function defaultAutomationDoc(ctx: AuthContext, input: UpsertAutomationInput) {
  validateTriggerAndActions(input.trigger, input.actions);
  validateLimits(input.limits);
  if (input.name.trim().length === 0) throw new ValidationError("name must not be empty.");
  if (input.presentedAs === "PROMOTION" && !input.marketing) {
    throw new ValidationError("marketing{} is required when presentedAs='PROMOTION'.");
  }
  return {
    merchantId: ctx.merchantId,
    name: input.name,
    trigger: input.trigger,
    conditions: input.conditions,
    actions: input.actions,
    limits: input.limits,
    presentedAs: input.presentedAs,
    marketing: input.presentedAs === "PROMOTION" ? input.marketing ?? null : null,
  };
}

export async function createAutomation(ctx: AuthContext, input: UpsertAutomationInput): Promise<string> {
  requirePermission(ctx, PERMISSIONS.AUTOMATION_MANAGE, ctx.merchantId);
  const doc = defaultAutomationDoc(ctx, input);

  const ref = getDb().collection(COLLECTIONS.automations).doc();
  await ref.set({
    ...doc,
    status: "DRAFT",
    lastTestRunSnapshot: null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "automation.created",
    targetType: "automation",
    targetId: ref.id,
    after: { name: input.name, presentedAs: input.presentedAs },
  });
  return ref.id;
}

async function loadAutomationOrThrow(automationId: string): Promise<Automation> {
  const snap = await getDb().collection(COLLECTIONS.automations).doc(automationId).get();
  if (!snap.exists) throw new NotFoundError(`Automation ${automationId} not found.`);
  return { id: snap.id, ...(snap.data() as Omit<Automation, "id">) };
}

export async function updateAutomation(
  ctx: AuthContext,
  automationId: string,
  input: UpsertAutomationInput,
): Promise<void> {
  const existing = await loadAutomationOrThrow(automationId);
  requirePermission(ctx, PERMISSIONS.AUTOMATION_MANAGE, existing.merchantId);
  const doc = defaultAutomationDoc(ctx, input);

  await getDb()
    .collection(COLLECTIONS.automations)
    .doc(automationId)
    .update({ ...doc, updatedAt: FieldValue.serverTimestamp() });
  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "automation.updated",
    targetType: "automation",
    targetId: automationId,
    before: { name: existing.name },
    after: { name: input.name },
  });
}

/** Lifecycle: DRAFT → TEST → ACTIVE ⇄ PAUSED → ENDED (§16). §16's Test Mode is explicitly
 * "บังคับก่อนเปิด Automation จริง" — moving to ACTIVE requires at least one prior dry-run
 * (`lastTestRunSnapshot != null`), enforced here, not just suggested in the UI. */
export async function setAutomationStatus(
  ctx: AuthContext,
  automationId: string,
  status: Automation["status"],
): Promise<void> {
  const existing = await loadAutomationOrThrow(automationId);
  requirePermission(ctx, PERMISSIONS.AUTOMATION_MANAGE, existing.merchantId);
  const VALID_STATUSES: readonly Automation["status"][] = ["DRAFT", "TEST", "ACTIVE", "PAUSED", "ENDED"];
  if (!VALID_STATUSES.includes(status)) throw new ValidationError(`Invalid status: ${status}`);
  if (status === "ACTIVE" && !existing.lastTestRunSnapshot) {
    throw new ValidationError("Run Test Mode (dry-run) at least once before activating this automation.");
  }

  await getDb()
    .collection(COLLECTIONS.automations)
    .doc(automationId)
    .update({ status, updatedAt: FieldValue.serverTimestamp() });
  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "automation.status_changed",
    targetType: "automation",
    targetId: automationId,
    before: { status: existing.status },
    after: { status },
  });
}

export async function listAutomations(ctx: AuthContext): Promise<Automation[]> {
  requirePermission(ctx, PERMISSIONS.AUTOMATION_MANAGE, ctx.merchantId);
  const snap = await getDb().collection(COLLECTIONS.automations).where("merchantId", "==", ctx.merchantId).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Automation, "id">) }));
}

export async function getAutomation(ctx: AuthContext, automationId: string): Promise<Automation> {
  const automation = await loadAutomationOrThrow(automationId);
  requirePermission(ctx, PERMISSIONS.AUTOMATION_MANAGE, automation.merchantId);
  return automation;
}

// --- Test Mode / dry-run ------------------------------------------------------------------

export interface DryRunResult {
  estimatedAffectedMembers: number;
}

/** §16 Test Mode: "query กลุ่มสมาชิกที่ match condition ปัจจุบัน (ไม่รัน action จริง)" — read-only,
 * never dispatches a real action, never writes ledger/coupon/reward/notification state. Only
 * writes `lastTestRunSnapshot` on the automation itself. */
export async function dryRunAutomation(ctx: AuthContext, automationId: string): Promise<DryRunResult> {
  const automation = await loadAutomationOrThrow(automationId);
  requirePermission(ctx, PERMISSIONS.AUTOMATION_MANAGE, automation.merchantId);

  // Real-time triggers: estimate against the full membership base filtered by conditions (a
  // rough "who could this ever match" estimate, since we don't have a live event to test against
  // in dry-run mode). Scheduled triggers behave identically for this estimate.
  const snap = await getDb().collection(COLLECTIONS.memberships).where("merchantId", "==", ctx.merchantId).get();
  const matching = snap.docs.filter((d) =>
    evaluateConditions(automation.conditions, { id: d.id, ...(d.data() as Omit<MembershipRecord, "id">) }),
  );

  const result: DryRunResult = { estimatedAffectedMembers: matching.length };
  await getDb()
    .collection(COLLECTIONS.automations)
    .doc(automationId)
    .update({
      lastTestRunSnapshot: { estimatedAffectedMembers: result.estimatedAffectedMembers, ranAt: Timestamp.now() },
      updatedAt: FieldValue.serverTimestamp(),
    });
  return result;
}

// --- Condition evaluation ------------------------------------------------------------------

function readField(membership: MembershipRecord, field: AutomationCondition["field"]): unknown {
  switch (field) {
    case "pointsBalance":
      return membership.pointsBalance;
    case "activityStats.segment":
      return membership.activityStats.segment;
    case "activityStats.visitCount30d":
      return membership.activityStats.visitCount30d;
    case "activityStats.visitCount90d":
      return membership.activityStats.visitCount90d;
    case "tags":
      return membership.tags;
    case "merchantProfile.consentMarketing":
      return membership.merchantProfile.consentMarketing;
  }
}

function evaluateCondition(condition: AutomationCondition, membership: MembershipRecord): boolean {
  const actual = readField(membership, condition.field);
  switch (condition.operator) {
    case "==":
      return actual === condition.value;
    case "!=":
      return actual !== condition.value;
    case ">":
      return (actual as number) > (condition.value as number);
    case ">=":
      return (actual as number) >= (condition.value as number);
    case "<":
      return (actual as number) < (condition.value as number);
    case "<=":
      return (actual as number) <= (condition.value as number);
    case "in":
      return Array.isArray(actual)
        ? actual.includes(condition.value)
        : (condition.value as unknown[]).includes(actual);
    case "not_in":
      return Array.isArray(actual)
        ? !actual.includes(condition.value)
        : !(condition.value as unknown[]).includes(actual);
  }
}

export function evaluateConditions(conditions: AutomationCondition[], membership: MembershipRecord): boolean {
  return conditions.every((c) => evaluateCondition(c, membership));
}

// --- Execution (system actor, no human AuthContext) -------------------------------------------

/** `executionKey = deterministicHash(eventId, automationId, membershipId, actionIndex)` — §17,
 * verbatim. `eventId` for scheduled (non-event-driven) triggers is synthesized as
 * `schedule:{automationId}:{YYYY-MM-DD}` so a given day's scheduled evaluation is itself
 * idempotent under retry, using the exact same hash formula — not a different mechanism. */
export function computeExecutionKey(
  eventId: string,
  automationId: string,
  membershipId: string,
  actionIndex: number,
): string {
  return createHash("sha256").update(`${eventId}:${automationId}:${membershipId}:${actionIndex}`).digest("hex");
}

const SYSTEM_ACTOR_ID = "system:automation";

/** A synthetic `AuthContext` used ONLY by this module to satisfy the shape the reused domain
 * service functions (`issueCouponInstance`, `redeemReward`) require — never derived from client
 * input, never exposed to any API route. `merchantId` always comes from the already-tenant-
 * validated `automations/{id}.merchantId` field loaded server-side (never caller input); `role:
 * 'OWNER'` reflects that automation execution carries the authority of whichever Owner/Manager
 * configured the automation (already gated behind `AUTOMATION_MANAGE` at creation time) — not a
 * new authorization decision, just a way to route through already-approved, already-tested
 * domain logic without duplicating it (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่"). */
function systemAuthContext(merchantId: string): AuthContext {
  return { authUid: SYSTEM_ACTOR_ID, merchantId, role: "OWNER", staffUserId: SYSTEM_ACTOR_ID, branchScope: [] };
}

interface SafetyLimitWindowCounts {
  execTodayForMember: number;
  execTotalForPromotion: number;
  pointsSpentBudget: number;
  couponsIssuedBudget: number;
  lastExecForMemberAt: Date | null;
}

/**
 * Reads every prior execution record for this automation (single query — `(merchantId,
 * automationId, createdAt desc)`, the composite index named in FINAL-ARCHITECTURE.md §28), then
 * derives every safety-limit count in memory. One index instead of several: execution volume per
 * automation is inherently bounded by these same safety limits, so this is intentionally simple
 * rather than prematurely optimized (§0's "หลีกเลี่ยง premature infrastructure complexity").
 */
async function readSafetyLimitCounts(
  tx: FirebaseFirestore.Transaction,
  merchantId: string,
  automationId: string,
  membershipId: string,
): Promise<SafetyLimitWindowCounts> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const snap = await tx.get(
    getDb()
      .collection(COLLECTIONS.automationActionExecutions)
      .where("merchantId", "==", merchantId)
      .where("automationId", "==", automationId)
      .orderBy("createdAt", "desc"),
  );

  let execTodayForMember = 0;
  let execTotalForPromotion = 0;
  let pointsSpentBudget = 0;
  let couponsIssuedBudget = 0;
  let lastExecForMemberAt: Date | null = null;
  for (const doc of snap.docs) {
    const data = doc.data() as {
      status: string;
      actionType: AutomationActionType;
      membershipId: string;
      createdAt: Timestamp;
    };
    if (data.status !== "EXECUTED") continue;
    execTotalForPromotion += 1;
    if (data.actionType === "ADD_POINTS") pointsSpentBudget += 1;
    if (data.actionType === "ISSUE_COUPON") couponsIssuedBudget += 1;
    if (data.membershipId === membershipId) {
      const at = data.createdAt.toDate();
      if (at >= startOfDay) execTodayForMember += 1;
      if (!lastExecForMemberAt || at > lastExecForMemberAt) lastExecForMemberAt = at;
    }
  }

  return { execTodayForMember, execTotalForPromotion, pointsSpentBudget, couponsIssuedBudget, lastExecForMemberAt };
}

function isOverLimit(limits: AutomationLimits, counts: SafetyLimitWindowCounts, action: AutomationAction): string | null {
  if (limits.maxExecPerCustomerPerDay !== null && counts.execTodayForMember >= limits.maxExecPerCustomerPerDay) {
    return "maxExecPerCustomerPerDay";
  }
  if (limits.maxExecPerPromotion !== null && counts.execTotalForPromotion >= limits.maxExecPerPromotion) {
    return "maxExecPerPromotion";
  }
  if (limits.cooldownHours !== null && counts.lastExecForMemberAt) {
    const hoursSince = (Date.now() - counts.lastExecForMemberAt.getTime()) / (1000 * 60 * 60);
    if (hoursSince < limits.cooldownHours) return "cooldownHours";
  }
  if (action.type === "ADD_POINTS" && limits.pointBudget !== null && counts.pointsSpentBudget >= limits.pointBudget) {
    return "pointBudget";
  }
  if (action.type === "ISSUE_COUPON" && limits.couponBudget !== null && counts.couponsIssuedBudget >= limits.couponBudget) {
    return "couponBudget";
  }
  return null;
}

/**
 * Executes ONE `actions[actionIndex]` of `automation` for `membershipId`, driven by `eventId`
 * (real event id, or the synthesized `schedule:...` pseudo-id for scheduled triggers).
 *
 * `ADD_POINTS`/`ADD_TAG` are fully self-composed in ONE Firestore transaction (idempotency check
 * + safety-limit read + the actual write, all inside the same transaction — §16 "ตรวจใน
 * transaction เดียวกับการรัน action", §26). `ISSUE_COUPON`/`ISSUE_REWARD` call the already-
 * atomic, already-idempotent `issueCouponInstance`/`redeemReward` directly, reusing THIS
 * function's own `executionKey` as THEIR `idempotencyKey` — this correctly prevents a duplicated
 * side effect end to end even though the execution-record write and the domain write are not one
 * single transaction (see the module doc comment on `systemAuthContext`), but it means the
 * safety-limit count for these two action types is read in a small transaction that does not also
 * atomically reserve the slot — a narrow, documented race window under concurrent DIFFERENT
 * events hitting the same automation+member simultaneously, bounded in practice by Coupon/
 * Reward's own template-level Total Limit/stock as a backstop. `SEND_NOTIFICATION`/
 * `NOTIFY_OWNER` never call an external adapter — see the module doc comment.
 */
export async function executeAutomationAction(params: {
  automation: Automation;
  actionIndex: number;
  membershipId: string;
  eventId: string;
}): Promise<{ status: "EXECUTED" | "SKIPPED_LIMIT" | "FAILED" | "ALREADY_PROCESSED" }> {
  const { automation, actionIndex, membershipId, eventId } = params;
  const action = automation.actions[actionIndex];
  const executionKey = computeExecutionKey(eventId, automation.id, membershipId, actionIndex);
  const db = getDb();
  const executionRef = db.collection(COLLECTIONS.automationActionExecutions).doc(executionKey);

  if (action.type === "ADD_POINTS" || action.type === "ADD_TAG") {
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(executionRef);
      if (existing.exists) return { status: "ALREADY_PROCESSED" as const };

      const membership = await loadMembershipForMerchantTx(tx, membershipId, automation.merchantId);
      const counts = await readSafetyLimitCounts(tx, automation.merchantId, automation.id, membershipId);
      const overLimit = isOverLimit(automation.limits, counts, action);
      if (overLimit) {
        tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "SKIPPED_LIMIT", null, overLimit));
        return { status: "SKIPPED_LIMIT" as const };
      }

      if (action.type === "ADD_POINTS") {
        const amount = Number(action.params.amount);
        if (!Number.isInteger(amount) || amount <= 0) {
          tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "FAILED", null, "invalid amount in action.params"));
          return { status: "FAILED" as const };
        }
        const merchantSnap = await tx.get(db.collection(COLLECTIONS.merchants).doc(automation.merchantId));
        const merchant = merchantSnap.data() as { pointsExpirationPolicy: Parameters<typeof computeExpiresAt>[0] };
        const ledgerRef = writeLedgerEntry(tx, {
          merchantId: automation.merchantId,
          membershipId,
          branchId: null,
          type: "EARN",
          delta: amount,
          reason: `Automation: ${automation.name}`,
          sourceType: "AUTOMATION",
          sourceRefId: automation.id,
          actorType: "system",
          actorId: SYSTEM_ACTOR_ID,
          idempotencyKey: executionKey,
        });
        createLot(tx, automation.merchantId, membershipId, ledgerRef.id, amount, computeExpiresAt(merchant.pointsExpirationPolicy, new Date()));
        tx.update(db.collection(COLLECTIONS.memberships).doc(membershipId), {
          pointsBalance: FieldValue.increment(amount),
          pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
        });
        // §15: automation-driven bonus is NOT a visit.
        writeEvent(tx, {
          merchantId: automation.merchantId,
          type: "points.earned",
          membershipId,
          payload: { ledgerEntryId: ledgerRef.id, delta: amount, sourceType: "AUTOMATION", automationId: automation.id },
        });
        tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "EXECUTED", ledgerRef.id, null));
      } else {
        const tag = String(action.params.tag ?? "");
        if (!tag) {
          tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "FAILED", null, "missing tag in action.params"));
          return { status: "FAILED" as const };
        }
        tx.update(db.collection(COLLECTIONS.memberships).doc(membershipId), { tags: FieldValue.arrayUnion(tag) });
        tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "EXECUTED", null, null));
      }
      void membership;
      writeAutomationEvent(tx, automation, membershipId);
      return { status: "EXECUTED" as const };
    });
  }

  if (action.type === "NOTIFY_OWNER") {
    // Locked Phase 7 decision ("NOTIFY_OWNER Delivery & Broadcast Test Send", §23): no Owner/Staff
    // LINE identity model exists — this action stays on the Phase 6 FAILED-seam indefinitely, not
    // just until Phase 7 ships. Never reinterpreted, never given a delivery path here.
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(executionRef);
      if (existing.exists) return { status: "ALREADY_PROCESSED" as const };
      tx.create(
        executionRef,
        baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "FAILED", null, "No Owner/Staff LINE identity model exists — NOTIFY_OWNER delivery is explicitly deferred (§23)."),
      );
      return { status: "FAILED" as const };
    });
  }

  if (action.type === "SEND_NOTIFICATION") {
    // Real delivery (Phase 7) — two-phase, same reasoning as ISSUE_COUPON/ISSUE_REWARD below:
    // `sendNotification` performs real network I/O (calls the LINE Messaging API), which cannot
    // run inside a Firestore transaction, so the executionKey gate and the delivery call are two
    // steps, with `sendNotification`'s own retry+log write as the source of truth for what
    // actually happened.
    const gateResult = await db.runTransaction(async (tx) => {
      const existing = await tx.get(executionRef);
      if (existing.exists) return { proceed: false as const };
      const counts = await readSafetyLimitCounts(tx, automation.merchantId, automation.id, membershipId);
      const overLimit = isOverLimit(automation.limits, counts, action);
      if (overLimit) {
        tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "SKIPPED_LIMIT", null, overLimit));
        return { proceed: false as const };
      }
      return { proceed: true as const };
    });
    if (!gateResult.proceed) {
      const snap = await executionRef.get();
      const status = (snap.data() as { status: "SKIPPED_LIMIT" } | undefined)?.status;
      return { status: status === "SKIPPED_LIMIT" ? "SKIPPED_LIMIT" : "ALREADY_PROCESSED" };
    }

    const result = await sendNotification({
      merchantId: automation.merchantId,
      membershipId,
      templateType: (action.params.templateType as NotificationTemplateType) ?? "PROMOTION",
      variables: (action.params.variables as Record<string, string | number>) ?? {},
    });
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(executionRef);
      if (existing.exists) return;
      tx.create(
        executionRef,
        baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, result.status === "sent" ? "EXECUTED" : "FAILED", null, result.error),
      );
    });
    return { status: result.status === "sent" ? "EXECUTED" : "FAILED" };
  }

  // ISSUE_COUPON / ISSUE_REWARD — see the function doc comment for why these two are two-phase.
  const gate = await db.runTransaction(async (tx) => {
    const existing = await tx.get(executionRef);
    if (existing.exists) return { proceed: false as const };
    const counts = await readSafetyLimitCounts(tx, automation.merchantId, automation.id, membershipId);
    const overLimit = isOverLimit(automation.limits, counts, action);
    if (overLimit) {
      tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "SKIPPED_LIMIT", null, overLimit));
      return { proceed: false as const };
    }
    return { proceed: true as const };
  });
  if (!gate.proceed) {
    const snap = await executionRef.get();
    const status = (snap.data() as { status: "SKIPPED_LIMIT" } | undefined)?.status;
    return { status: status === "SKIPPED_LIMIT" ? "SKIPPED_LIMIT" : "ALREADY_PROCESSED" };
  }

  const ctx = systemAuthContext(automation.merchantId);
  try {
    let resultRef: string;
    if (action.type === "ISSUE_COUPON") {
      const result = await issueCouponInstance(ctx, {
        membershipId,
        couponTemplateId: String(action.params.couponTemplateId ?? ""),
        branchId: null,
        issuedVia: "CAMPAIGN",
        countsAsVisit: false,
        idempotencyKey: executionKey,
      });
      resultRef = result.instanceId;
    } else {
      // ISSUE_REWARD: reuses `redeemReward` verbatim — an automation-driven "auto-redeem on the
      // member's own real points balance", not a new "free grant" concept (Reward's Phase 4
      // domain has no such concept; see the Phase 6 implementation notes). If the member can't
      // afford `rewardTemplateId`, `redeemReward` throws and this action is recorded FAILED —
      // a misconfigured automation, not a system bug.
      const result = await redeemReward(ctx, {
        membershipId,
        rewardTemplateId: String(action.params.rewardTemplateId ?? ""),
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: executionKey,
      });
      resultRef = result.voucherId;
    }
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(executionRef);
      if (existing.exists) return;
      tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "EXECUTED", resultRef, null));
      writeAutomationEvent(tx, automation, membershipId);
    });
    return { status: "EXECUTED" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "unknown error";
    await db.runTransaction(async (tx) => {
      const existing = await tx.get(executionRef);
      if (existing.exists) return;
      tx.create(executionRef, baseExecutionDoc(automation, action, actionIndex, eventId, membershipId, "FAILED", null, reason));
    });
    return { status: "FAILED" };
  }
}

function baseExecutionDoc(
  automation: Automation,
  action: AutomationAction,
  actionIndex: number,
  eventId: string,
  membershipId: string,
  status: "EXECUTED" | "SKIPPED_LIMIT" | "FAILED",
  resultRef: string | null,
  failureReason: string | null,
) {
  return {
    merchantId: automation.merchantId,
    eventId,
    automationId: automation.id,
    membershipId,
    actionIndex,
    actionType: action.type,
    status,
    resultRef,
    failureReason,
    createdAt: FieldValue.serverTimestamp(),
  };
}

function writeAutomationEvent(tx: FirebaseFirestore.Transaction, automation: Automation, membershipId: string): void {
  writeEvent(tx, {
    merchantId: automation.merchantId,
    type: automation.presentedAs === "PROMOTION" ? "promotion.triggered" : "automation.executed",
    membershipId,
    payload: { automationId: automation.id },
  });
}

// --- Dispatch: real-time (onEventCreate) ------------------------------------------------------

/** Called by the `onEventCreate` Cloud Function for every `events/{eventId}` write. Finds
 * `ACTIVE` automations whose trigger matches this event's type, evaluates `conditions[]`, and
 * executes every action in order. Never throws for a single automation/action's own business
 * failure (recorded as FAILED, §17 dead-letter handling picks it up on Cloud Functions retry) —
 * only rethrows on an unexpected/infra error so the whole event is retried, matching §17
 * verbatim. */
export async function dispatchEventToAutomations(event: {
  id: string;
  merchantId: string;
  type: DomainEventType;
  membershipId?: string;
}): Promise<void> {
  const triggerType = EVENT_TYPE_TO_TRIGGER_TYPE[event.type];
  if (!triggerType || !event.membershipId) return;

  const snap = await getDb()
    .collection(COLLECTIONS.automations)
    .where("merchantId", "==", event.merchantId)
    .where("trigger.type", "==", triggerType)
    .where("status", "==", "ACTIVE")
    .get();
  if (snap.empty) return;

  const membership = await loadMembershipRaw(event.merchantId, event.membershipId);
  if (!membership) return;

  for (const doc of snap.docs) {
    const automation = { id: doc.id, ...(doc.data() as Omit<Automation, "id">) };
    if (!evaluateConditions(automation.conditions, membership)) continue;
    for (let i = 0; i < automation.actions.length; i++) {
      await executeAutomationAction({ automation, actionIndex: i, membershipId: membership.id, eventId: event.id });
    }
  }
}

async function loadMembershipRaw(merchantId: string, membershipId: string): Promise<MembershipRecord | null> {
  const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
  if (!snap.exists) return null;
  const data = { id: snap.id, ...(snap.data() as Omit<MembershipRecord, "id">) };
  if (data.merchantId !== merchantId) return null;
  return data;
}

