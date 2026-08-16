import type { Timestamp } from "firebase-admin/firestore";

/**
 * `events/{eventId}` — §5, §17: "business event log", written atomically (same transaction) with
 * the state change it reports. Destined to drive the Automation Engine (Phase 6)/Report aggregates
 * (Phase 8) — neither exists yet, so nothing consumes these documents through Phase 4 either.
 *
 * §17's full Event Types list is much longer (`customer.created`, `promotion.triggered`,
 * `staff.login`, ...) — only the types this codebase's own domain services can actually produce
 * as of Phase 5 are listed here. Extend this union, not a generic `string`, as each later phase
 * adds its own producer — keeps a typo in an event type a compile error.
 */
export type DomainEventType =
  | "points.earned"
  | "points.adjusted"
  | "points.reversed"
  | "visit.recorded"
  | "reward.redeemed"
  | "reward.used"
  | "coupon.issued"
  | "coupon.redeemed"
  | "membership.created"
  | "automation.executed"
  | "promotion.triggered"
  | "notification.sent"
  | "notification.failed";

export interface DomainEvent {
  id: string;
  merchantId: string;
  type: DomainEventType;
  payload: Record<string, unknown>;
  membershipId?: string;
  schemaVersion: number;
  createdAt: Timestamp;
}
