import type { Timestamp } from "firebase-admin/firestore";

/**
 * Promotion/Automation domain (FINAL-ARCHITECTURE.md §16, §17) — Phase 6.
 *
 * "Automation คือ Engine เดียว, Promotion คือหน้าตาเท่านั้น" — ONE `automations` collection is the
 * single source of truth for both; `presentedAs` is a label only, never affects execution (§16).
 *
 * LOCKED DEFERRALS (do not reinterpret — see FINAL-ARCHITECTURE.md §16 for the full text):
 * - `BIRTHDAY` stays in `AutomationTriggerType` for forward compatibility only — no field/config/
 *   scheduled evaluation/UI selection exists for it in Phase 6 (Phase 6 BIRTHDAY Decision, Locked).
 * - `CHANGE_TIER` stays in `AutomationActionType` for forward compatibility only — no Membership
 *   Tier system, no dispatch case, no UI selection in Phase 6 (Phase 6 CHANGE_TIER Decision, Locked).
 * - `SEND_NOTIFICATION`/`NOTIFY_OWNER` are configurable and idempotent like every other action,
 *   but never actually deliver anything — no `ChannelAdapter` exists before Phase 7 (§23, §33).
 */

export type AutomationTriggerType =
  | "MEMBER_CREATED"
  | "BIRTHDAY" // DEFERRED — see module doc comment
  | "POINTS_REACHED"
  | "INACTIVE_DAYS"
  | "COUPON_EXPIRING"
  | "COUPON_REDEEMED"
  | "REWARD_REDEEMED"
  | "SCHEDULE";

/** Trigger types Phase 6 must reject at automation create/update time (locked deferral). */
export const DEFERRED_TRIGGER_TYPES: readonly AutomationTriggerType[] = ["BIRTHDAY"];

/** Trigger types evaluated by the scheduled daily batch (day-level latency, §16) rather than the
 * real-time `onEventCreate` path. `BIRTHDAY` would belong here too but is deferred. */
export const SCHEDULED_TRIGGER_TYPES: readonly AutomationTriggerType[] = [
  "INACTIVE_DAYS",
  "COUPON_EXPIRING",
  "SCHEDULE",
];

export interface AutomationTrigger {
  type: AutomationTriggerType;
  /** Per-automation config for the trigger (e.g. `SCHEDULE`'s target date, `COUPON_EXPIRING`'s
   * days-before-expiry threshold) — never a global hard-coded constant (CLAUDE.md: "ห้าม
   * hard-code...threshold"), matches the `segmentRulesConfig` precedent of being merchant/
   * automation-configurable. */
  config: Record<string, unknown>;
}

/** Whitelisted, closed set of comparable Membership fields — all already documented in §5/§7.
 * Extending this list is an implementation detail (exposing more of an already-documented
 * schema), never a new business rule. */
export type AutomationConditionField =
  | "pointsBalance"
  | "activityStats.segment"
  | "activityStats.visitCount30d"
  | "activityStats.visitCount90d"
  | "tags"
  | "merchantProfile.consentMarketing";

export type AutomationConditionOperator = "==" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_in";

export interface AutomationCondition {
  field: AutomationConditionField;
  operator: AutomationConditionOperator;
  value: unknown;
}

export type AutomationActionType =
  | "ADD_POINTS"
  | "ISSUE_COUPON"
  | "ISSUE_REWARD"
  | "ADD_TAG"
  | "CHANGE_TIER" // DEFERRED — see module doc comment
  | "SEND_NOTIFICATION"
  | "NOTIFY_OWNER";

/** Action types Phase 6 must reject at automation create/update time (locked deferral). */
export const DEFERRED_ACTION_TYPES: readonly AutomationActionType[] = ["CHANGE_TIER"];

/** Action types Phase 6 accepts and idempotently records, but never actually delivers — no
 * `ChannelAdapter` exists before Phase 7 (§23, §33). Not a deferral in the same sense as
 * CHANGE_TIER/BIRTHDAY — configuring them is allowed, only real delivery is out of scope. */
export const NOTIFICATION_SEAM_ACTION_TYPES: readonly AutomationActionType[] = [
  "SEND_NOTIFICATION",
  "NOTIFY_OWNER",
];

export interface AutomationAction {
  type: AutomationActionType;
  params: Record<string, unknown>;
}

export interface AutomationLimits {
  maxExecPerCustomerPerDay: number | null;
  maxExecPerPromotion: number | null;
  pointBudget: number | null;
  couponBudget: number | null;
  cooldownHours: number | null;
}

export type AutomationStatus = "DRAFT" | "TEST" | "ACTIVE" | "PAUSED" | "ENDED";
export type PresentedAs = "AUTOMATION" | "PROMOTION";

export interface AutomationMarketing {
  title: string;
  description: string;
  bannerImageUrl: string | null;
  visibleInCustomerPortal: boolean;
}

export interface TestRunSnapshot {
  estimatedAffectedMembers: number;
  ranAt: Timestamp;
}

/** `automations/{id}` — §5, §16. */
export interface Automation {
  id: string;
  merchantId: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  limits: AutomationLimits;
  presentedAs: PresentedAs;
  marketing: AutomationMarketing | null;
  status: AutomationStatus;
  lastTestRunSnapshot: TestRunSnapshot | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type AutomationExecutionStatus = "EXECUTED" | "SKIPPED_LIMIT" | "FAILED";

/** `automationActionExecutions/{executionKey}` — §5, §17.
 * `executionKey = deterministicHash(eventId, automationId, membershipId, actionIndex)`. */
export interface AutomationActionExecution {
  merchantId: string;
  eventId: string;
  automationId: string;
  membershipId: string;
  actionIndex: number;
  actionType: AutomationActionType;
  status: AutomationExecutionStatus;
  resultRef: string | null;
  failureReason: string | null;
  createdAt: Timestamp;
}
