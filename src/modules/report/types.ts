import type { Timestamp } from "firebase-admin/firestore";

/**
 * Reports (FINAL-ARCHITECTURE.md §5, §24) — Phase 8.
 *
 * Two distinct collections, two distinct purposes (§24 "Snapshot Pattern"):
 * - `merchantDailyStats/{merchantId_date}` — a live, incrementally-updated cache for real-time
 *   Dashboard KPIs. Mutable (today's doc keeps changing all day); NOT the audit record.
 * - `reports/{reportId}` — a FROZEN snapshot for a completed Daily/Weekly/Monthly period, written
 *   once and never touched again (§24: "เปลี่ยน Settings วันนี้ห้ามเปลี่ยน Report เก่า"). Computed by
 *   summing the relevant `merchantDailyStats` day-docs for the period — those day-docs are
 *   themselves derived transitively from `events`/`pointsLedger`/`voucherInstances`/
 *   `couponInstances` (§24's named raw sources), so this is the same aggregation, done once
 *   instead of twice, not a deviation from what §24 requires.
 */

export type ReportType = "daily" | "weekly" | "monthly";

/** Phase 8 V1: Dashboard only — see §24 "Report Delivery Channel Scope" (Locked). LINE/Email stay
 * unavailable until a future Owner/Staff LINE identity decision unblocks them. */
export type ReportDeliveryChannel = "DASHBOARD";

/**
 * Metrics common to `merchantDailyStats` and a `reports/{id}.snapshotData`. §24's KPI list maps to
 * these fields as follows (documented mapping, not an invented business rule — the Segment enum
 * itself, §15, is already fully specified; this just names which enum value backs which §24 label
 * that isn't itself a Segment value):
 * - "New Members" = memberships created within the period/day (`membership.created` events)
 * - "Active Members" = `activityStats.segment === 'ACTIVE'` count, as of period end
 * - "Returning Members" (§24's Weekly/Monthly wording) = `activityStats.segment === 'REGULAR'`
 *   count, as of period end — REGULAR is the Segment enum's own "visits enough to count as a
 *   repeat/returning customer" value (§15), the closest already-defined concept to "returning"
 * - "At Risk" / "Inactive" / "VIP" = the identically-named Segment values, as of period end
 * - "Total Members" = total membership count for the merchant, as of period end
 * - "Points Earned" = sum of `points.earned` event deltas in the period
 * - "Points Redeemed" = sum of `reward.redeemed` event `requiredPoints` in the period (the only
 *   points-spending path in this codebase — there is no separate points-only spend flow, §12/§13)
 * - "Rewards Redeemed/Used" = count of `reward.redeemed`/`reward.used` events in the period
 * - "Coupons Issued/Used" = count of `coupon.issued`/`coupon.redeemed` events in the period
 *   (Coupon's single post-issue lifecycle step is literally named "redeemed", §14 — it is the
 *   Coupon analogue of Reward's "Used" step, not a second issuance)
 */
export interface ReportMetrics {
  membersTotal: number;
  membersNew: number;
  membersActive: number;
  membersReturning: number;
  membersAtRisk: number;
  membersInactive: number;
  membersVip: number;
  pointsEarned: number;
  pointsRedeemed: number;
  rewardsRedeemed: number;
  rewardsUsed: number;
  couponsIssued: number;
  couponsUsed: number;
}

export const ZERO_REPORT_METRICS: ReportMetrics = {
  membersTotal: 0,
  membersNew: 0,
  membersActive: 0,
  membersReturning: 0,
  membersAtRisk: 0,
  membersInactive: 0,
  membersVip: 0,
  pointsEarned: 0,
  pointsRedeemed: 0,
  rewardsRedeemed: 0,
  rewardsUsed: 0,
  couponsIssued: 0,
  couponsUsed: 0,
};

/**
 * `merchantDailyStats/{merchantId}_{date}` — §5, §24. `date` is the merchant-LOCAL calendar day
 * (§24 "Report Period Boundaries — Merchant-Local Timezone", Locked), never a UTC day.
 *
 * `ReportMetrics` fields are `Partial` here (unlike `ReportRecord.snapshotData`, which is always
 * complete) because this doc is built by TWO independent partial-merge (`{merge:true}`) writers —
 * `updateDailyStatsForEvent` (the incremental fields, event-triggered, any time of day) and
 * `recomputeMemberSnapshotForMerchant` (the Segment-snapshot fields, once daily) — so a day with
 * events but no batch-job run yet (or vice versa) genuinely has some fields absent, not zero.
 * Every reader must treat a missing field as `0`, never assume the full shape (`generateReport`
 * does this explicitly, `?? 0` on every field it reads).
 */
export interface MerchantDailyStats extends Partial<ReportMetrics> {
  merchantId: string;
  date: string; // YYYY-MM-DD, merchant-local
  updatedAt: Timestamp;
}

/** `reports/{reportId}` — §5, §24. Frozen once written; `deliveredChannels` is Dashboard-only in
 * V1 (§24 "Report Delivery Channel Scope", Locked). */
export interface ReportRecord {
  id: string;
  merchantId: string;
  type: ReportType;
  periodStart: Timestamp;
  periodEnd: Timestamp;
  snapshotData: ReportMetrics;
  generatedAt: Timestamp;
  deliveredChannels: ReportDeliveryChannel[];
}
