import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { getMerchantRecordOrThrow } from "@/modules/merchant/service";
import type { DailyReportItem, MonthlyReportItem, ReportSettings, WeeklyReportItem } from "@/modules/merchant/types";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { DomainEventType } from "@/modules/event/types";
import type { MerchantDailyStats, ReportMetrics, ReportRecord, ReportType } from "@/modules/report/types";
import { ZERO_REPORT_METRICS } from "@/modules/report/types";
import { NotFoundError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { checkIdempotencyKey, recordIdempotencyKey } from "@/modules/shared/idempotency";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Reports (FINAL-ARCHITECTURE.md §5, §24) — Phase 8. See `report/types.ts` for the schema
 * rationale and the §24-item-to-field mapping. This module is used by:
 * - Staff-facing API routes (`getReportSettings`/`updateReportSettings`/`listReports`/`getReport`)
 *   — every one of these takes an `AuthContext` and goes through `requirePermission`.
 * - Server-only Cloud Function code (`updateDailyStatsForEvent`/`recomputeMemberSnapshotForMerchant`/
 *   `generateDueReportsForMerchant`) — no `AuthContext`, same category as
 *   `dispatchEventToAutomations`/`dailyAutomationBatch` (Phase 6): trusted server code acting on
 *   `merchantId` that is itself already server-derived (from a written `events/{eventId}` doc or a
 *   `merchants` collection scan), never client input.
 */

const db = () => getDb();

const dailyStatsRef = (merchantId: string, dateKey: string) =>
  db().collection(COLLECTIONS.merchantDailyStats).doc(`${merchantId}_${dateKey}`);

// ---- §24 "Report Period Boundaries — Merchant-Local Timezone" (Phase 8, Locked) ----------------

export interface DayBoundary {
  /** YYYY-MM-DD, merchant-local calendar day. */
  dateKey: string;
  /** UTC instant of merchant-local midnight that BEGINS this day. */
  dayStart: Date;
  /** UTC instant of merchant-local midnight that begins the NEXT day (exclusive end). */
  dayEnd: Date;
}

/**
 * Resolves the merchant-local calendar day containing `at`, via `Intl.DateTimeFormat` (built into
 * Node — no new dependency, per the locked decision) rather than `dailyAutomationBatch`'s (Phase 6)
 * UTC-day simplification, because a Report's date range is content the Owner reads directly, not
 * an internal-only key.
 *
 * The offset is derived from the formatter itself (correct for any IANA zone) rather than a fixed
 * lookup table — `dayEnd = dayStart + 24h` is a documented simplification that assumes no DST
 * transition within the day, true for V1's Thailand-only target (`Asia/Bangkok` has no DST) and
 * acceptable for any other fixed-offset zone; a zone with a DST transition would need a more
 * involved calculation this platform doesn't need yet.
 */
export function resolveMerchantDayBoundary(timezone: string, at: Date): DayBoundary {
  // en-CA formats as YYYY-MM-DD directly — avoids hand-parsing a locale-specific separator.
  const dateKey = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const localAsUtcMs = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  const offsetMs = localAsUtcMs - at.getTime();

  const [y, m, d] = dateKey.split("-").map(Number);
  const dayStart = new Date(Date.UTC(y, m - 1, d) - offsetMs);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  return { dateKey, dayStart, dayEnd };
}

function addDaysToDateKey(dateKey: string, deltaDays: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

function dayOfWeekForDateKey(dateKey: string): number {
  // 0=Sunday..6=Saturday — safe to compute via UTC here: we only need the calendar date's
  // weekday, and `dateKey` is already merchant-local, timezone-agnostic once reduced to Y-M-D.
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isFirstOfMonth(dateKey: string): boolean {
  return dateKey.slice(-2) === "01";
}

function firstOfPreviousMonthDateKey(dateKey: string): string {
  const [y, m] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10); // m is 1-indexed; m-2 = previous month, 0-indexed
}

/** Re-resolves a `dateKey` back to its `DayBoundary` in `timezone`. Noon UTC is used as the probe
 * instant — safely inside the intended calendar day for any real-world timezone offset within
 * ±11h of UTC, which covers V1's Thailand-only target (`Asia/Bangkok`, UTC+7) with margin. */
function boundaryForDateKey(timezone: string, dateKey: string): DayBoundary {
  const [y, m, d] = dateKey.split("-").map(Number);
  return resolveMerchantDayBoundary(timezone, new Date(Date.UTC(y, m - 1, d, 12)));
}

// ---- Report Settings (`merchants/{merchantId}.reportSettings`, §24 Locked) ----------------------

const DAILY_ITEMS: readonly DailyReportItem[] = ["NEW_MEMBERS", "ACTIVE", "POINTS", "REWARDS", "COUPONS", "STAFF_ACTIVITY"];
const WEEKLY_ITEMS: readonly WeeklyReportItem[] = ["GROWTH", "RETURNING", "AT_RISK", "INACTIVE", "PROMOTION_PERFORMANCE"];
const MONTHLY_ITEMS: readonly MonthlyReportItem[] = [
  "MEMBERSHIP_GROWTH",
  "RETENTION",
  "REWARD_COUPON_PERFORMANCE",
  "STAFF_SUMMARY",
];

export async function getReportSettings(ctx: AuthContext): Promise<ReportSettings> {
  requirePermission(ctx, PERMISSIONS.REPORT_VIEW, ctx.merchantId);
  const merchant = await getMerchantRecordOrThrow(ctx.merchantId);
  return merchant.reportSettings;
}

export interface UpdateReportSettingsInput {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  monthlyEnabled: boolean;
  dailyItems: DailyReportItem[];
  weeklyItems: WeeklyReportItem[];
  monthlyItems: MonthlyReportItem[];
}

/** Owner/Manager only (`MERCHANT_SETTINGS_MANAGE`, §9) — Staff cannot view or manage Reports. */
export async function updateReportSettings(ctx: AuthContext, input: UpdateReportSettingsInput): Promise<void> {
  requirePermission(ctx, PERMISSIONS.MERCHANT_SETTINGS_MANAGE, ctx.merchantId);

  for (const item of input.dailyItems) {
    if (!DAILY_ITEMS.includes(item)) throw new ValidationError(`Invalid daily report item: ${String(item)}`);
  }
  for (const item of input.weeklyItems) {
    if (!WEEKLY_ITEMS.includes(item)) throw new ValidationError(`Invalid weekly report item: ${String(item)}`);
  }
  for (const item of input.monthlyItems) {
    if (!MONTHLY_ITEMS.includes(item)) throw new ValidationError(`Invalid monthly report item: ${String(item)}`);
  }

  const settings: ReportSettings = {
    dailyEnabled: input.dailyEnabled,
    weeklyEnabled: input.weeklyEnabled,
    monthlyEnabled: input.monthlyEnabled,
    dailyItems: input.dailyItems,
    weeklyItems: input.weeklyItems,
    monthlyItems: input.monthlyItems,
  };

  await db().collection(COLLECTIONS.merchants).doc(ctx.merchantId).update({ reportSettings: settings });

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "report_settings.updated",
    targetType: "merchant",
    targetId: ctx.merchantId,
    after: settings,
  });
}

// ---- `merchantDailyStats` maintenance ------------------------------------------------------

const EVENT_METRIC_DELTA: Partial<Record<DomainEventType, (payload: Record<string, unknown>) => Partial<ReportMetrics>>> = {
  "membership.created": () => ({ membersNew: 1 }),
  "points.earned": (payload) => ({ pointsEarned: typeof payload.delta === "number" ? payload.delta : 0 }),
  "reward.redeemed": (payload) => ({
    rewardsRedeemed: 1,
    pointsRedeemed: typeof payload.requiredPoints === "number" ? payload.requiredPoints : 0,
  }),
  "reward.used": () => ({ rewardsUsed: 1 }),
  "coupon.issued": () => ({ couponsIssued: 1 }),
  // §14: Coupon's single post-issue lifecycle step is the `coupon.redeemed` event (there is no
  // separate coupon.used) — that step IS "using" the coupon, so it's what backs "Coupons Used".
  "coupon.redeemed": () => ({ couponsUsed: 1 }),
};

/**
 * §24 "Snapshot Pattern" real-time half — incremental per-event update of TODAY's
 * `merchantDailyStats` doc. Intended to be called from the `onEventCreate` Cloud Function trigger
 * (Phase 6) alongside — not instead of — Automation dispatch. Only handles metrics that are
 * genuinely event-driven; the Segment-distribution metrics are handled separately by
 * `recomputeMemberSnapshotForMerchant` (see its own doc comment for why).
 *
 * Idempotent via the shared `idempotencyKeys` mechanism (§27), keyed on `eventId` (namespaced
 * `report:{eventId}` so it can never collide with an unrelated caller's own idempotency key) and
 * checked/recorded inside the SAME transaction as the `FieldValue.increment` write — required
 * because Cloud Functions' event delivery is only at-least-once (§17): a retried/duplicate
 * `onEventCreate` invocation for the identical `events/{eventId}` doc must never increment these
 * counters twice, or a permanently-frozen `reports/{id}` snapshot downstream would carry an
 * inflated, uncorrectable number — unlike `pointsLedger`'s own idempotency (a different key, a
 * different collection), this one exists specifically to protect Phase 8's own aggregate.
 */
export async function updateDailyStatsForEvent(event: {
  eventId: string;
  merchantId: string;
  type: DomainEventType;
  payload: Record<string, unknown>;
}): Promise<void> {
  const deltaFn = EVENT_METRIC_DELTA[event.type];
  if (!deltaFn) return; // not a report-relevant event type

  const delta = deltaFn(event.payload);
  if (Object.keys(delta).length === 0) return;

  const merchant = await getMerchantRecordOrThrow(event.merchantId);
  const { dateKey } = resolveMerchantDayBoundary(merchant.timezone, new Date());
  const statsRef = dailyStatsRef(event.merchantId, dateKey);
  const idempotencyKey = `report:${event.eventId}`;

  await db().runTransaction(async (tx) => {
    const existing = await checkIdempotencyKey(tx, event.merchantId, "report.dailyStats", idempotencyKey);
    if (existing) return; // already applied for this exact event — idempotent no-op

    const increments: Record<string, FirebaseFirestore.FieldValue> = {};
    for (const [key, value] of Object.entries(delta)) {
      increments[key] = FieldValue.increment(value as number);
    }
    tx.set(
      statsRef,
      { merchantId: event.merchantId, date: dateKey, updatedAt: FieldValue.serverTimestamp(), ...increments },
      { merge: true },
    );
    recordIdempotencyKey(tx, event.merchantId, "report.dailyStats", idempotencyKey, statsRef.id);
  });
}

/**
 * §24 "Snapshot Pattern" batch half — recomputes the Segment-distribution fields
 * (`membersTotal`/`membersActive`/`membersReturning`/`membersAtRisk`/`membersInactive`/
 * `membersVip`) once per merchant per day. Intended to be called from `dailyAutomationBatch`
 * immediately after that same job finishes recalculating every membership's
 * `activityStats.segment` for this merchant (§15 Activity Stats Maintenance, Phase 8 Locked) —
 * reusing the exact moment those values are freshest, rather than a separate schedule or
 * per-event recomputation (`activityStats.segment` itself never changes on an event — only once a
 * day, in that same batch job — so recomputing these counts per-event would be both wasteful and
 * meaningless, per CLAUDE.md "ห้ามมี logic ซ้ำสองที่").
 */
export async function recomputeMemberSnapshotForMerchant(merchantId: string, timezone: string, now: Date): Promise<void> {
  const memberships = db().collection(COLLECTIONS.memberships);
  const countBySegment = async (segment?: string): Promise<number> => {
    const query = segment
      ? memberships.where("merchantId", "==", merchantId).where("activityStats.segment", "==", segment)
      : memberships.where("merchantId", "==", merchantId);
    const snap = await query.count().get();
    return snap.data().count;
  };

  const [membersTotal, membersActive, membersReturning, membersAtRisk, membersInactive, membersVip] = await Promise.all([
    countBySegment(),
    countBySegment("ACTIVE"),
    countBySegment("REGULAR"),
    countBySegment("AT_RISK"),
    countBySegment("INACTIVE"),
    countBySegment("VIP"),
  ]);

  const { dateKey } = resolveMerchantDayBoundary(timezone, now);
  await dailyStatsRef(merchantId, dateKey).set(
    {
      merchantId,
      date: dateKey,
      membersTotal,
      membersActive,
      membersReturning,
      membersAtRisk,
      membersInactive,
      membersVip,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}

// ---- Report generation (`reports/{id}`, frozen snapshot) ---------------------------------------

/**
 * §24 Snapshot Pattern — aggregates the completed period `[periodStart, periodEnd)` by summing the
 * `merchantDailyStats` day-docs it covers (themselves derived transitively from
 * `events`/`pointsLedger`/`voucherInstances`/`couponInstances`, §24's named raw sources — this is
 * the same aggregation, done once instead of twice), and writes a FROZEN `reports/{id}` doc.
 *
 * Idempotent via a deterministic id: a retried/duplicate scheduler invocation for a period that
 * already has a report is a silent no-op (§26/§27) — it can never produce two reports for the same
 * period or overwrite an already-generated (possibly already-viewed) one.
 */
export async function generateReport(params: {
  merchantId: string;
  type: ReportType;
  periodStartDateKey: string; // inclusive
  periodEndDateKeyInclusive: string; // inclusive — the last day counted in this period
  periodStart: Date;
  periodEnd: Date;
}): Promise<string> {
  const reportId = `${params.merchantId}_${params.type}_${params.periodStartDateKey}`;
  const ref = db().collection(COLLECTIONS.reports).doc(reportId);
  const existing = await ref.get();
  if (existing.exists) return reportId; // already generated for this period — idempotent no-op

  const dayDocsSnap = await db()
    .collection(COLLECTIONS.merchantDailyStats)
    .where("merchantId", "==", params.merchantId)
    .where("date", ">=", params.periodStartDateKey)
    .where("date", "<=", params.periodEndDateKeyInclusive)
    .get();

  // A day's `merchantDailyStats` doc can legitimately be missing some fields — it's written by TWO
  // independent partial-merge writers (`updateDailyStatsForEvent`'s incremental fields vs.
  // `recomputeMemberSnapshotForMerchant`'s segment-snapshot fields, §24) — e.g. a day with only
  // points/coupon events but no daily-batch run yet has no `membersTotal` at all. `?? 0` below
  // guards every field read for exactly this reason; without it, an absent field reads back as
  // `undefined`, which Firestore's `.create()` rejects outright as an invalid document value.
  const summed: ReportMetrics = { ...ZERO_REPORT_METRICS };
  let closingDayStats: MerchantDailyStats | null = null;
  for (const doc of dayDocsSnap.docs) {
    const stats = doc.data() as MerchantDailyStats;
    summed.membersNew += stats.membersNew ?? 0;
    summed.pointsEarned += stats.pointsEarned ?? 0;
    summed.pointsRedeemed += stats.pointsRedeemed ?? 0;
    summed.rewardsRedeemed += stats.rewardsRedeemed ?? 0;
    summed.rewardsUsed += stats.rewardsUsed ?? 0;
    summed.couponsIssued += stats.couponsIssued ?? 0;
    summed.couponsUsed += stats.couponsUsed ?? 0;
    if (stats.date === params.periodEndDateKeyInclusive) closingDayStats = stats;
  }
  // Segment-distribution fields are a point-in-time snapshot, not summable across days — use the
  // period's LAST day's values ("as of the end of this period"). Left at zero if that exact day's
  // doc (or any of these fields on it) doesn't exist yet (e.g. a brand-new merchant with no
  // activity at all that day, or a day the batch job hasn't processed yet) — a reasonable empty
  // state, not a guess.
  if (closingDayStats) {
    summed.membersTotal = closingDayStats.membersTotal ?? 0;
    summed.membersActive = closingDayStats.membersActive ?? 0;
    summed.membersReturning = closingDayStats.membersReturning ?? 0;
    summed.membersAtRisk = closingDayStats.membersAtRisk ?? 0;
    summed.membersInactive = closingDayStats.membersInactive ?? 0;
    summed.membersVip = closingDayStats.membersVip ?? 0;
  }

  try {
    await ref.create({
      merchantId: params.merchantId,
      type: params.type,
      periodStart: Timestamp.fromDate(params.periodStart),
      periodEnd: Timestamp.fromDate(params.periodEnd),
      snapshotData: summed,
      generatedAt: FieldValue.serverTimestamp(),
      // §24 "Report Delivery Channel Scope" (Phase 8, Locked) — Dashboard-only in V1.
      deliveredChannels: ["DASHBOARD"],
    });
  } catch {
    // A concurrent invocation won the create race (`.create()` is atomically create-iff-absent at
    // the Firestore server, even outside a transaction) — that's the idempotent outcome we want,
    // not an error to propagate. Confirm it really did land before treating this as success.
    const recheck = await ref.get();
    if (!recheck.exists) throw new Error(`Failed to generate report ${reportId}.`);
  }

  return reportId;
}

/**
 * Called once per merchant per `dailyAutomationBatch` run (Phase 6 schedule, extended Phase 8) —
 * generates whichever of Daily/Weekly/Monthly reports just became due (their period just
 * completed as of merchant-local yesterday) for whichever frequencies this merchant has enabled.
 * Weekly reports cover the 7 days Monday–Sunday, generated the following Monday; Monthly reports
 * cover the full previous calendar month, generated the 1st of the new month — both computed from
 * merchant-local `dateKey`s (§24 "Report Period Boundaries", Locked), not UTC.
 */
export async function generateDueReportsForMerchant(merchantId: string, timezone: string, now: Date): Promise<void> {
  const merchant = await getMerchantRecordOrThrow(merchantId);
  const settings = merchant.reportSettings;
  if (!settings.dailyEnabled && !settings.weeklyEnabled && !settings.monthlyEnabled) return;

  const today = resolveMerchantDayBoundary(timezone, now);
  const yesterdayDateKey = addDaysToDateKey(today.dateKey, -1);

  if (settings.dailyEnabled) {
    await generateReport({
      merchantId,
      type: "daily",
      periodStartDateKey: yesterdayDateKey,
      periodEndDateKeyInclusive: yesterdayDateKey,
      periodStart: boundaryForDateKey(timezone, yesterdayDateKey).dayStart,
      periodEnd: boundaryForDateKey(timezone, yesterdayDateKey).dayEnd,
    });
  }

  if (settings.weeklyEnabled && dayOfWeekForDateKey(today.dateKey) === 1 /* Monday */) {
    const weekStartDateKey = addDaysToDateKey(yesterdayDateKey, -6);
    await generateReport({
      merchantId,
      type: "weekly",
      periodStartDateKey: weekStartDateKey,
      periodEndDateKeyInclusive: yesterdayDateKey,
      periodStart: boundaryForDateKey(timezone, weekStartDateKey).dayStart,
      periodEnd: boundaryForDateKey(timezone, yesterdayDateKey).dayEnd,
    });
  }

  if (settings.monthlyEnabled && isFirstOfMonth(today.dateKey)) {
    const monthStartDateKey = firstOfPreviousMonthDateKey(today.dateKey);
    await generateReport({
      merchantId,
      type: "monthly",
      periodStartDateKey: monthStartDateKey,
      periodEndDateKeyInclusive: yesterdayDateKey,
      periodStart: boundaryForDateKey(timezone, monthStartDateKey).dayStart,
      periodEnd: boundaryForDateKey(timezone, yesterdayDateKey).dayEnd,
    });
  }
}

// ---- Reading reports (staff-facing, RBAC + tenant-isolation gated) -----------------------------

export interface ListReportsFilter {
  type?: ReportType;
  limit?: number;
}

export async function listReports(ctx: AuthContext, filter: ListReportsFilter = {}): Promise<ReportRecord[]> {
  requirePermission(ctx, PERMISSIONS.REPORT_VIEW, ctx.merchantId);

  let query: FirebaseFirestore.Query = db().collection(COLLECTIONS.reports).where("merchantId", "==", ctx.merchantId);
  if (filter.type) query = query.where("type", "==", filter.type);
  query = query.orderBy("periodStart", "desc").limit(filter.limit ?? 50);

  const snap = await query.get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<ReportRecord, "id">) }));
}

/** Anti-IDOR pattern (§10, §26): query by opaque doc id, then explicitly check merchant ownership
 * and reject with `TenantIsolationError` on mismatch — never confirm cross-tenant existence. */
export async function getReport(ctx: AuthContext, reportId: string): Promise<ReportRecord> {
  requirePermission(ctx, PERMISSIONS.REPORT_VIEW, ctx.merchantId);

  const snap = await db().collection(COLLECTIONS.reports).doc(reportId).get();
  if (!snap.exists) throw new NotFoundError(`Report ${reportId} not found.`);
  const record = { id: snap.id, ...(snap.data() as Omit<ReportRecord, "id">) };
  if (record.merchantId !== ctx.merchantId) {
    throw new TenantIsolationError(
      `Staff of merchant ${ctx.merchantId} attempted to read a report of merchant ${record.merchantId}.`,
    );
  }
  return record;
}
