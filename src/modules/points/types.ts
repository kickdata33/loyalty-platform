import type { Timestamp } from "firebase-admin/firestore";

/** `pointRules/{ruleId}` — FINAL-ARCHITECTURE.md §11. */
export type PointRuleType = "PER_UNIT" | "PER_VISIT" | "AMOUNT_BASED" | "BONUS_EVENT" | "MULTIPLIER";
export type PointRuleRole = "BASE" | "MODIFIER";
export type StackingPolicy = "ADDITIVE" | "HIGHEST_ONLY" | "MULTIPLICATIVE";
export type BonusEvent = "NEW_MEMBER" | "BIRTHDAY";

export interface PointRuleConfig {
  // PER_UNIT
  unit?: "HOUR" | "MINUTE";
  pointsPerUnit?: number;
  // PER_VISIT
  pointsPerVisit?: number;
  // AMOUNT_BASED — scaffolded per §11, deliberately NOT wired to any Phase 3 API input: "เตรียม
  // ไว้ ยังไม่ใช้จริงจนมี trusted amount source (POS ในอนาคต)".
  pointsPer?: number;
  amountPer?: number;
  // BONUS_EVENT
  event?: BonusEvent;
  points?: number;
  multipliable?: boolean;
  // MULTIPLIER
  factor?: number;
  dayOfWeek?: number[];
  timeRange?: { start: string; end: string };
}

export interface PointRule {
  id: string;
  merchantId: string;
  name: string;
  enabled: boolean;
  type: PointRuleType;
  role: PointRuleRole;
  branchScope: string[];
  startAt: Timestamp | null;
  endAt: Timestamp | null;
  priority: number;
  stackingPolicy: StackingPolicy;
  config: PointRuleConfig;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** `pointsLedger/{entryId}` — immutable, append-only. §12. */
export type PointsLedgerEntryType = "EARN" | "SPEND" | "ADJUSTMENT" | "REVERSAL" | "EXPIRATION";

export interface AppliedRule {
  ruleId: string;
  ruleName: string;
  contribution: number;
}

export interface PointsLedgerEntry {
  id: string;
  merchantId: string;
  membershipId: string;
  branchId: string | null;
  type: PointsLedgerEntryType;
  delta: number;
  reason: string;
  sourceType: string;
  sourceRefId: string | null;
  appliedRules?: AppliedRule[];
  actorType: "staff" | "system" | "customer";
  actorId: string;
  reversedBy?: string;
  reversalOf?: string;
  createdAt: Timestamp;
  idempotencyKey: string;
}

/** `pointsLots/{lotId}` — one per EARN (or positive ADJUSTMENT/REVERSAL). §12. */
export type PointsLotStatus = "ACTIVE" | "DEPLETED" | "EXPIRED";

export interface PointsLot {
  id: string;
  merchantId: string;
  membershipId: string;
  originLedgerEntryId: string;
  earnedAmount: number;
  remainingAmount: number;
  expiresAt: Timestamp | null;
  status: PointsLotStatus;
  createdAt: Timestamp;
}

/** `pointsLotConsumptions/{consumptionId}` — append-only allocation trace. §12. */
export interface PointsLotConsumption {
  id: string;
  merchantId: string;
  membershipId: string;
  spendLedgerEntryId: string;
  lotId: string;
  amountConsumed: number;
  createdAt: Timestamp;
}

/**
 * `events/{eventId}` — §17: "business event log", written atomically (same transaction) with the
 * state change it reports, and destined to drive the Automation Engine (Phase 6)/Report
 * aggregates (Phase 8) — neither of which exists yet, so nothing consumes these documents in
 * Phase 3. Only the points/visit event types this phase's own domain services can actually
 * produce are listed here; later phases add their own as those domains ship.
 */
export type PointsEventType = "points.earned" | "points.adjusted" | "points.reversed" | "visit.recorded";

export interface DomainEvent {
  id: string;
  merchantId: string;
  type: PointsEventType;
  payload: Record<string, unknown>;
  membershipId?: string;
  schemaVersion: number;
  createdAt: Timestamp;
}

/** `visits/{visitId}` — §15. */
export type VisitSource = "STAFF_SCAN" | "STAFF_SEARCH" | "MANUAL_ENTRY" | "AUTOMATION";

export interface Visit {
  id: string;
  merchantId: string;
  membershipId: string;
  branchId: string | null;
  source: VisitSource;
  countsAsVisit: boolean;
  relatedRefs: {
    pointsLedgerEntryId?: string;
    couponInstanceId?: string;
    voucherInstanceId?: string;
  };
  recordedAt: Timestamp;
  createdBy: string;
}
