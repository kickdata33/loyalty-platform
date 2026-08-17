import { FieldValue } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import {
  generateDueReportsForMerchant,
  generateReport,
  getReport,
  listReports,
  recomputeMemberSnapshotForMerchant,
  resolveMerchantDayBoundary,
  updateDailyStatsForEvent,
  updateReportSettings,
} from "@/modules/report/service";
import type { MerchantDailyStats, ReportRecord } from "@/modules/report/types";
import { createMembership } from "@/modules/membership/service";
import { AuthorizationError, NotFoundError, TenantIsolationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { addStaffFixture, createMerchantFixture, uniqueId } from "./setup";

/**
 * §24 "Snapshot Pattern" (Phase 8) — `merchantDailyStats` incremental maintenance,
 * `reports/{id}` frozen-snapshot generation (idempotency, period summing), and RBAC/tenant
 * isolation on the staff-facing read paths. These call `report/service.ts` functions directly —
 * the same thing the `onEventCreate`/`dailyAutomationBatch` Cloud Function triggers do in
 * production (see `functions/src/index.ts`) — because the emulator test runner only starts
 * Auth+Firestore (`npm run test:emulator`), not Functions, matching the existing precedent in
 * `automation-execution.test.ts` for `dispatchEventToAutomations`/`executeAutomationAction`.
 */

const TIMEZONE = "Asia/Bangkok";

async function dailyStatsDoc(merchantId: string, dateKey: string): Promise<MerchantDailyStats | undefined> {
  const snap = await getDb().collection(COLLECTIONS.merchantDailyStats).doc(`${merchantId}_${dateKey}`).get();
  return snap.data() as MerchantDailyStats | undefined;
}

async function seedDailyStats(merchantId: string, dateKey: string, values: Partial<MerchantDailyStats>): Promise<void> {
  await getDb()
    .collection(COLLECTIONS.merchantDailyStats)
    .doc(`${merchantId}_${dateKey}`)
    .set({ merchantId, date: dateKey, updatedAt: FieldValue.serverTimestamp(), ...values }, { merge: true });
}

function nextMonday(from: Date): Date {
  const d = new Date(from);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(12, 0, 0, 0); // noon UTC — safely inside the same Bangkok calendar day
  return d;
}

describe("updateDailyStatsForEvent — real-time incremental half of §24 Snapshot Pattern", () => {
  it("increments the right field for each report-relevant event type, on TODAY's merchant-local day doc", async () => {
    const { merchantId } = await createMerchantFixture();
    const now = new Date();
    const { dateKey } = resolveMerchantDayBoundary(TIMEZONE, now);

    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId, type: "membership.created", payload: {} });
    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId, type: "points.earned", payload: { delta: 15 } });
    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId, type: "points.earned", payload: { delta: 5 } });
    await updateDailyStatsForEvent({
      eventId: uniqueId("evt"),
      merchantId,
      type: "reward.redeemed",
      payload: { requiredPoints: 50 },
    });
    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId, type: "reward.used", payload: {} });
    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId, type: "coupon.issued", payload: {} });
    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId, type: "coupon.redeemed", payload: {} });
    // Not report-relevant — must be a silent no-op, never throw, never create a spurious field.
    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId, type: "notification.sent", payload: {} });

    const stats = await dailyStatsDoc(merchantId, dateKey);
    expect(stats).toMatchObject({
      membersNew: 1,
      pointsEarned: 20,
      pointsRedeemed: 50,
      rewardsRedeemed: 1,
      rewardsUsed: 1,
      couponsIssued: 1,
      couponsUsed: 1,
    });
  });

  it("two different merchants' events never mix into the same day doc (tenant isolation)", async () => {
    const a = await createMerchantFixture("A");
    const b = await createMerchantFixture("B");
    const { dateKey } = resolveMerchantDayBoundary(TIMEZONE, new Date());

    await updateDailyStatsForEvent({ eventId: uniqueId("evt"), merchantId: a.merchantId, type: "points.earned", payload: { delta: 100 } });
    const statsA = await dailyStatsDoc(a.merchantId, dateKey);
    const statsB = await dailyStatsDoc(b.merchantId, dateKey);
    expect(statsA?.pointsEarned).toBe(100);
    expect(statsB).toBeUndefined();
  });

  it("is idempotent per eventId — a retried/duplicate delivery of the SAME event never double-counts (§17 at-least-once delivery)", async () => {
    const { merchantId } = await createMerchantFixture();
    const { dateKey } = resolveMerchantDayBoundary(TIMEZONE, new Date());
    const eventId = uniqueId("evt");

    await updateDailyStatsForEvent({ eventId, merchantId, type: "points.earned", payload: { delta: 15 } });
    // Cloud Functions' onEventCreate retrying/re-delivering the IDENTICAL events/{eventId} doc —
    // same eventId, same payload — must not increment pointsEarned a second time.
    await updateDailyStatsForEvent({ eventId, merchantId, type: "points.earned", payload: { delta: 15 } });
    await updateDailyStatsForEvent({ eventId, merchantId, type: "points.earned", payload: { delta: 15 } });

    const stats = await dailyStatsDoc(merchantId, dateKey);
    expect(stats?.pointsEarned).toBe(15); // NOT 45
  });
});

describe("recomputeMemberSnapshotForMerchant — batch half of §24 Snapshot Pattern", () => {
  it("counts memberships by activityStats.segment into today's day doc", async () => {
    const { merchantId, ownerCtx } = await createMerchantFixture();
    const ids = await Promise.all([1, 2, 3].map(() => createMembership(ownerCtx, { displayName: "Somchai" })));
    const db = getDb();
    await db.collection(COLLECTIONS.memberships).doc(ids[0]).update({ "activityStats.segment": "ACTIVE" });
    await db.collection(COLLECTIONS.memberships).doc(ids[1]).update({ "activityStats.segment": "ACTIVE" });
    await db.collection(COLLECTIONS.memberships).doc(ids[2]).update({ "activityStats.segment": "AT_RISK" });

    const now = new Date();
    await recomputeMemberSnapshotForMerchant(merchantId, TIMEZONE, now);

    const { dateKey } = resolveMerchantDayBoundary(TIMEZONE, now);
    const stats = await dailyStatsDoc(merchantId, dateKey);
    expect(stats).toMatchObject({ membersTotal: 3, membersActive: 2, membersAtRisk: 1, membersReturning: 0, membersInactive: 0, membersVip: 0 });
  });
});

describe("generateReport — frozen snapshot, sums merchantDailyStats over the period, idempotent", () => {
  it("sums the incremental fields across every day in the period and uses the CLOSING day's segment snapshot", async () => {
    const { merchantId } = await createMerchantFixture();
    await seedDailyStats(merchantId, "2026-01-01", { pointsEarned: 10, couponsIssued: 1, membersTotal: 5, membersActive: 1 });
    await seedDailyStats(merchantId, "2026-01-02", { pointsEarned: 20, couponsIssued: 2, membersTotal: 6, membersActive: 2 });
    await seedDailyStats(merchantId, "2026-01-03", { pointsEarned: 5, couponsIssued: 0, membersTotal: 7, membersActive: 3 });

    const reportId = await generateReport({
      merchantId,
      type: "daily",
      periodStartDateKey: "2026-01-01",
      periodEndDateKeyInclusive: "2026-01-03",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2026-01-04T00:00:00Z"),
    });

    const snap = await getDb().collection(COLLECTIONS.reports).doc(reportId).get();
    const record = snap.data() as ReportRecord;
    expect(record.snapshotData.pointsEarned).toBe(35); // summed across all 3 days
    expect(record.snapshotData.couponsIssued).toBe(3); // summed across all 3 days
    expect(record.snapshotData.membersTotal).toBe(7); // CLOSING day's point-in-time value, not summed
    expect(record.snapshotData.membersActive).toBe(3); // CLOSING day's point-in-time value, not summed
    expect(record.deliveredChannels).toEqual(["DASHBOARD"]); // §24 Report Delivery Channel Scope, Locked
  });

  it("is idempotent — a second call for the same period is a silent no-op, never a duplicate/overwrite", async () => {
    const { merchantId } = await createMerchantFixture();
    await seedDailyStats(merchantId, "2026-02-01", { pointsEarned: 42 });

    const first = await generateReport({
      merchantId,
      type: "daily",
      periodStartDateKey: "2026-02-01",
      periodEndDateKeyInclusive: "2026-02-01",
      periodStart: new Date("2026-02-01T00:00:00Z"),
      periodEnd: new Date("2026-02-02T00:00:00Z"),
    });

    // Mutate the underlying day doc AFTER the first report was generated — a real "Settings changed
    // today must not change an old Report" scenario (§24). The frozen report must not pick this up.
    await seedDailyStats(merchantId, "2026-02-01", { pointsEarned: 999 });

    const second = await generateReport({
      merchantId,
      type: "daily",
      periodStartDateKey: "2026-02-01",
      periodEndDateKeyInclusive: "2026-02-01",
      periodStart: new Date("2026-02-01T00:00:00Z"),
      periodEnd: new Date("2026-02-02T00:00:00Z"),
    });

    expect(second).toBe(first);
    const snap = await getDb().collection(COLLECTIONS.reports).doc(first).get();
    expect((snap.data() as ReportRecord).snapshotData.pointsEarned).toBe(42); // still the ORIGINAL value
  });

  // Concurrency safety for `generateReport` (two/three concurrent invocations for the SAME
  // period never producing duplicate reports) is covered in `race-conditions.test.ts`, alongside
  // every other domain's race tests, rather than duplicated here.
});

describe("generateDueReportsForMerchant — only generates a frequency when it's actually due", () => {
  it("generates a Daily report every run when dailyEnabled, and skips Weekly/Monthly on a non-boundary day", async () => {
    const { merchantId, ownerCtx } = await createMerchantFixture();
    await updateReportSettings(ownerCtx, {
      dailyEnabled: true,
      weeklyEnabled: true,
      monthlyEnabled: true,
      dailyItems: [],
      weeklyItems: [],
      monthlyItems: [],
    });

    // Pick a day that is neither a Monday nor the 1st of the month.
    let notBoundary = new Date();
    while (notBoundary.getUTCDay() === 1 || notBoundary.getUTCDate() === 1) {
      notBoundary = new Date(notBoundary.getTime() + 24 * 60 * 60 * 1000);
    }
    notBoundary.setUTCHours(12, 0, 0, 0);

    await generateDueReportsForMerchant(merchantId, TIMEZONE, notBoundary);

    const reports = await getDb().collection(COLLECTIONS.reports).where("merchantId", "==", merchantId).get();
    const types = reports.docs.map((d) => (d.data() as ReportRecord).type);
    expect(types).toContain("daily");
    expect(types).not.toContain("weekly");
    expect(types).not.toContain("monthly");
  });

  it("generates a Weekly report only when merchant-local 'today' is Monday", async () => {
    const { merchantId, ownerCtx } = await createMerchantFixture();
    await updateReportSettings(ownerCtx, {
      dailyEnabled: false,
      weeklyEnabled: true,
      monthlyEnabled: false,
      dailyItems: [],
      weeklyItems: [],
      monthlyItems: [],
    });

    const monday = nextMonday(new Date());
    await generateDueReportsForMerchant(merchantId, TIMEZONE, monday);

    const reports = await getDb().collection(COLLECTIONS.reports).where("merchantId", "==", merchantId).get();
    expect(reports.docs.map((d) => (d.data() as ReportRecord).type)).toEqual(["weekly"]);
  });

  it("generates a Monthly report only when merchant-local 'today' is the 1st", async () => {
    const { merchantId, ownerCtx } = await createMerchantFixture();
    await updateReportSettings(ownerCtx, {
      dailyEnabled: false,
      weeklyEnabled: false,
      monthlyEnabled: true,
      dailyItems: [],
      weeklyItems: [],
      monthlyItems: [],
    });

    const firstOfMonth = new Date(Date.UTC(2026, 8, 1, 12)); // 2026-09-01, noon UTC
    await generateDueReportsForMerchant(merchantId, TIMEZONE, firstOfMonth);

    const reports = await getDb().collection(COLLECTIONS.reports).where("merchantId", "==", merchantId).get();
    expect(reports.docs.map((d) => (d.data() as ReportRecord).type)).toEqual(["monthly"]);
  });

  it("a merchant with everything disabled generates nothing", async () => {
    const { merchantId } = await createMerchantFixture();
    await generateDueReportsForMerchant(merchantId, TIMEZONE, new Date());
    const reports = await getDb().collection(COLLECTIONS.reports).where("merchantId", "==", merchantId).get();
    expect(reports.size).toBe(0);
  });
});

describe("listReports / getReport — RBAC (§9) + tenant isolation/IDOR (§10, §26)", () => {
  it("Staff cannot list or read reports; Owner/Manager can", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await expect(listReports(staff.ctx)).rejects.toThrow(AuthorizationError);

    await seedDailyStats(ownerCtx.merchantId, "2026-04-01", { pointsEarned: 1 });
    const reportId = await generateReport({
      merchantId: ownerCtx.merchantId,
      type: "daily",
      periodStartDateKey: "2026-04-01",
      periodEndDateKeyInclusive: "2026-04-01",
      periodStart: new Date("2026-04-01T00:00:00Z"),
      periodEnd: new Date("2026-04-02T00:00:00Z"),
    });
    await expect(getReport(staff.ctx, reportId)).rejects.toThrow(AuthorizationError);
    await expect(getReport(ownerCtx, reportId)).resolves.toMatchObject({ id: reportId });
  });

  it("a different merchant's Owner cannot read this report by guessed/known id (TenantIsolationError)", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    await seedDailyStats(merchantA.merchantId, "2026-05-01", { pointsEarned: 1 });
    const reportId = await generateReport({
      merchantId: merchantA.merchantId,
      type: "daily",
      periodStartDateKey: "2026-05-01",
      periodEndDateKeyInclusive: "2026-05-01",
      periodStart: new Date("2026-05-01T00:00:00Z"),
      periodEnd: new Date("2026-05-02T00:00:00Z"),
    });

    await expect(getReport(merchantB.ownerCtx, reportId)).rejects.toThrow(TenantIsolationError);
  });

  it("a nonexistent report id throws NotFoundError, not a silent null", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(getReport(ownerCtx, uniqueId("nope"))).rejects.toThrow(NotFoundError);
  });

  it("listReports never returns another merchant's reports", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    await seedDailyStats(merchantA.merchantId, "2026-06-01", { pointsEarned: 1 });
    await generateReport({
      merchantId: merchantA.merchantId,
      type: "daily",
      periodStartDateKey: "2026-06-01",
      periodEndDateKeyInclusive: "2026-06-01",
      periodStart: new Date("2026-06-01T00:00:00Z"),
      periodEnd: new Date("2026-06-02T00:00:00Z"),
    });

    const reportsForB = await listReports(merchantB.ownerCtx);
    expect(reportsForB).toHaveLength(0);
  });
});
