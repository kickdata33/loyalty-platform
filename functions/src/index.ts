import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";

import type { DomainEventType } from "../../src/modules/event/types";
import type { MembershipRecord, Segment } from "../../src/modules/membership/types";
import type { SegmentRulesConfig } from "../../src/modules/merchant/types";
import {
  dispatchEventToAutomations,
  evaluateConditions,
  executeAutomationAction,
} from "../../src/modules/promotion-automation/service";
import type { Automation } from "../../src/modules/promotion-automation/types";
import { SCHEDULED_TRIGGER_TYPES } from "../../src/modules/promotion-automation/types";
import type { StaffUserClaimsSnapshot } from "../../src/modules/rbac/staff-claims";
import { syncStaffCustomClaims } from "../../src/modules/rbac/staff-claims";
import { reportCriticalError } from "../../src/modules/ops-alert/service";
import { findBalanceMismatchesForMerchant } from "../../src/modules/reconciliation/service";
import {
  generateDueReportsForMerchant,
  recomputeMemberSnapshotForMerchant,
  updateDailyStatsForEvent,
} from "../../src/modules/report/service";
import { SYSTEM_HEALTH_COMPONENTS } from "../../src/modules/system-health/types";
import type { SystemHealthStatus } from "../../src/modules/system-health/types";

// Ambient service identity in the Cloud Functions runtime (and the emulator) — no config needed,
// never a hard-coded credential (FINAL-ARCHITECTURE.md §1, §26).
initializeApp();

/**
 * The ONE mechanism that sets Firebase Auth custom claims for staff/owner users
 * (FINAL-ARCHITECTURE.md §8, §10, §32). Reacts to every write of `staffUsers/{staffUserId}` —
 * create, update, or delete — regardless of which server code path performed it, and delegates
 * the actual claims logic to the framework-agnostic `syncStaffCustomClaims` module shared with
 * this repo's Next.js app and its tests (§31), so there is exactly one implementation of "how do
 * StaffUser fields map to custom claims" in the entire codebase.
 */
export const onStaffUserWrite = onDocumentWritten(
  "staffUsers/{staffUserId}",
  async (event) => {
    const { staffUserId } = event.params;
    const before = (event.data?.before.exists
      ? (event.data.before.data() as StaffUserClaimsSnapshot)
      : null) as StaffUserClaimsSnapshot | null;
    const after = (event.data?.after.exists
      ? (event.data.after.data() as StaffUserClaimsSnapshot)
      : null) as StaffUserClaimsSnapshot | null;

    await syncStaffCustomClaims(getAuth(), { staffUserId, before, after });
  },
);

/**
 * Real-time Automation dispatch (FINAL-ARCHITECTURE.md §16, §17) — Phase 6.
 *
 * "Domain Service เขียน state change (transaction) → เขียน events/{eventId} ใน transaction เดียวกัน
 * → Cloud Function trigger (onCreate events/{eventId}) → ส่งเข้า Automation Engine" — this is that
 * trigger. All matching/condition/safety-limit/idempotency logic lives in
 * `promotion-automation/service.ts` (imported, not duplicated — CLAUDE.md "ห้ามมี logic ซ้ำสองที่");
 * this function is a thin adapter from the Firestore event shape to that module's own input shape.
 *
 * Phase 8 extends this SAME trigger with `updateDailyStatsForEvent` (§24 "Snapshot Pattern" real-
 * time half) — another consumer of the same `events/{eventId}` stream, run alongside (not instead
 * of) Automation dispatch. `Promise.all` (not `allSettled`): if either consumer throws, the whole
 * handler throws and Cloud Functions retries the ENTIRE event — the same "let the whole event
 * retry, idempotency makes it safe" policy §17 already documents for Automation actions, now
 * covering both consumers, since `updateDailyStatsForEvent` is ALSO idempotent per-eventId (see
 * its own doc comment) — a retry can never double-count or double-execute either one.
 */
export const onEventCreate = onDocumentCreated("events/{eventId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data() as {
    merchantId: string;
    type: DomainEventType;
    membershipId?: string;
    payload?: Record<string, unknown>;
  };
  await Promise.all([
    dispatchEventToAutomations({
      id: event.params.eventId,
      merchantId: data.merchantId,
      type: data.type,
      membershipId: data.membershipId,
    }),
    updateDailyStatsForEvent({
      eventId: event.params.eventId,
      merchantId: data.merchantId,
      type: data.type,
      payload: data.payload ?? {},
    }),
  ]);
});

/**
 * Scheduled Automation batch (FINAL-ARCHITECTURE.md §15, §16) — Phase 6. Once daily (Cloud
 * Scheduler): (1) recalculates `membership.activityStats.segment` per merchant's own
 * `segmentRulesConfig`, and (2) evaluates the scheduled-only trigger types (`INACTIVE_DAYS`,
 * `SCHEDULE`, `COUPON_EXPIRING`) for every `ACTIVE` automation — the SAME job for both, per §15's
 * explicit "ไม่สร้างระบบคำนวณซ้ำสองชุด" instruction. `BIRTHDAY` is intentionally NOT evaluated here
 * (locked Phase 6 decision). Day-level latency is explicitly accepted for these trigger types
 * (§16).
 *
 * Segment derivation uses only the three documented `segmentRulesConfig` fields
 * (`inactiveAfterDays`, `atRiskAfterDays`, `regularMinVisits30d`) — `VIP` has no supporting config
 * anywhere in the Architecture and is therefore never assigned by this job (a documented, honest
 * scoping — not a guess at an undefined threshold). A membership that has never visited
 * (`firstVisitAt == null`) is left `NEW`, never reclassified by this job.
 */
async function runDailyAutomationBatch(): Promise<void> {
  const db = getFirestore();
  const now = new Date();

  const merchantsSnap = await db.collection("merchants").get();
  for (const merchantDoc of merchantsSnap.docs) {
    const merchantId = merchantDoc.id;
    const segmentRulesConfig = merchantDoc.data().segmentRulesConfig as SegmentRulesConfig | undefined;

    const membershipsSnap = await db.collection("memberships").where("merchantId", "==", merchantId).get();
    const automationsSnap = await db
      .collection("automations")
      .where("merchantId", "==", merchantId)
      .where("status", "==", "ACTIVE")
      .get();
    const scheduledAutomations = automationsSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<Automation, "id">) }))
      .filter((a) => SCHEDULED_TRIGGER_TYPES.includes(a.trigger.type));

    const todayKey = now.toISOString().slice(0, 10); // YYYY-MM-DD, UTC — documented simplification

    for (const memberDoc of membershipsSnap.docs) {
      const membership = { id: memberDoc.id, ...(memberDoc.data() as Omit<MembershipRecord, "id">) };
      const updates: Record<string, unknown> = {};

      // (0) Rolling `visitCount30d`/`visitCount90d` — §15 "Activity Stats Maintenance" (Phase 8,
      // Locked): a ROLLING window, so it's recomputed fresh here every day from `visits` (never
      // incremented at visit-time, which would never decay and would stop meaning "last N days").
      // Skipped entirely for a member who has never visited (`firstVisitAt == null`) — count is 0
      // by definition, no query needed. Uses the SAME composite index already provisioned for
      // Phase 3 (`merchantId`, `membershipId`, `recordedAt desc`, §28) — no new index required.
      // Not filtered by `visits.countsAsVisit` because no code path in this codebase ever writes a
      // `visits` document with `countsAsVisit: false` (`recordVisit` only creates one when its
      // caller has already gated on `countsAsVisit: true` — see `points/ledger-service.ts`), so the
      // two are equivalent today; revisit this comment if a future phase adds one.
      if (membership.activityStats.firstVisitAt) {
        const cutoff30 = Timestamp.fromMillis(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        const cutoff90 = Timestamp.fromMillis(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        const visitsRef = db.collection("visits").where("merchantId", "==", merchantId).where("membershipId", "==", membership.id);
        const [count30Snap, count90Snap] = await Promise.all([
          visitsRef.where("recordedAt", ">=", cutoff30).count().get(),
          visitsRef.where("recordedAt", ">=", cutoff90).count().get(),
        ]);
        const visitCount30d = count30Snap.data().count;
        const visitCount90d = count90Snap.data().count;
        if (visitCount30d !== membership.activityStats.visitCount30d) updates["activityStats.visitCount30d"] = visitCount30d;
        if (visitCount90d !== membership.activityStats.visitCount90d) updates["activityStats.visitCount90d"] = visitCount90d;
        // Segment's REGULAR branch below must see today's freshly recomputed count, not the
        // (possibly stale) value already on `membership` from before this loop iteration ran.
        membership.activityStats.visitCount30d = visitCount30d;
      }

      // (1) Segment recalculation — see function doc comment for the exact, non-invented formula.
      if (segmentRulesConfig && membership.activityStats.firstVisitAt && membership.activityStats.lastVisitAt) {
        const daysSinceLastVisit =
          (now.getTime() - membership.activityStats.lastVisitAt.toDate().getTime()) / (1000 * 60 * 60 * 24);
        let nextSegment: Segment;
        if (daysSinceLastVisit >= segmentRulesConfig.inactiveAfterDays) nextSegment = "INACTIVE";
        else if (daysSinceLastVisit >= segmentRulesConfig.atRiskAfterDays) nextSegment = "AT_RISK";
        else if (membership.activityStats.visitCount30d >= segmentRulesConfig.regularMinVisits30d) nextSegment = "REGULAR";
        else nextSegment = "ACTIVE";
        if (nextSegment !== membership.activityStats.segment) {
          updates["activityStats.segment"] = nextSegment;
        }
      }

      if (Object.keys(updates).length > 0) {
        await memberDoc.ref.update(updates);
      }

      // (2) INACTIVE_DAYS / SCHEDULE trigger evaluation for this member.
      for (const automation of scheduledAutomations) {
        if (automation.trigger.type === "COUPON_EXPIRING") continue; // handled per-coupon below
        if (!evaluateConditions(automation.conditions, membership)) continue;

        let matches = false;
        if (automation.trigger.type === "INACTIVE_DAYS" && segmentRulesConfig && membership.activityStats.lastVisitAt) {
          const days = (now.getTime() - membership.activityStats.lastVisitAt.toDate().getTime()) / (1000 * 60 * 60 * 24);
          matches = days >= segmentRulesConfig.inactiveAfterDays;
        } else if (automation.trigger.type === "SCHEDULE") {
          matches = automation.trigger.config.scheduledAt === todayKey;
        }
        if (!matches) continue;

        const eventId = `schedule:${automation.id}:${todayKey}`;
        for (let i = 0; i < automation.actions.length; i++) {
          await executeAutomationAction({ automation, actionIndex: i, membershipId: membership.id, eventId });
        }
      }
    }

    // (2.5) Phase 8 §24 "Snapshot Pattern" — now that every membership's `activityStats.segment`
    // for this merchant is freshly recalculated (step 1 above), snapshot the Segment distribution
    // into today's `merchantDailyStats` doc (`recomputeMemberSnapshotForMerchant`), then generate
    // whichever Daily/Weekly/Monthly report just became due (`generateDueReportsForMerchant`) —
    // which reads that same freshly-written doc. Order matters: this must run AFTER the membership
    // loop above, never before.
    const timezone = merchantDoc.data().timezone as string | undefined;
    if (timezone) {
      await recomputeMemberSnapshotForMerchant(merchantId, timezone, now);
      await generateDueReportsForMerchant(merchantId, timezone, now);
    }

    // (3) COUPON_EXPIRING — per-automation, scans `couponInstances` directly (uses the
    // `(merchantId, status, expiresAt)` index already built in Phase 5, §28).
    for (const automation of scheduledAutomations) {
      if (automation.trigger.type !== "COUPON_EXPIRING") continue;
      const daysBefore = Number(automation.trigger.config.daysBeforeExpiry ?? 3);
      const threshold = Timestamp.fromMillis(now.getTime() + daysBefore * 24 * 60 * 60 * 1000);
      const expiringSnap = await db
        .collection("couponInstances")
        .where("merchantId", "==", merchantId)
        .where("status", "==", "AVAILABLE")
        .where("expiresAt", "<=", threshold)
        .get();
      const eventId = `schedule:${automation.id}:${todayKey}`;
      for (const instanceDoc of expiringSnap.docs) {
        const membershipId = (instanceDoc.data() as { membershipId: string }).membershipId;
        const memberSnap = await db.collection("memberships").doc(membershipId).get();
        if (!memberSnap.exists) continue;
        const membership = { id: memberSnap.id, ...(memberSnap.data() as Omit<MembershipRecord, "id">) };
        if (!evaluateConditions(automation.conditions, membership)) continue;
        for (let i = 0; i < automation.actions.length; i++) {
          await executeAutomationAction({ automation, actionIndex: i, membershipId, eventId });
        }
      }
    }
  }

  // System Health foundation (§32, §37; Phase 9) — the ONLY honest signal this codebase has for
  // the "Scheduler" component: "this batch job actually completed a full run just now". Read by
  // `systemHealthSelfCheck` below to derive a staleness-based status; this write only records the
  // fact, never a status judgement, since a per-run write is unconditional (this line is only
  // reached after every merchant above finished without throwing).
  await db
    .collection("systemHealth")
    .doc("Scheduler")
    .set({ component: "Scheduler", lastCheckedAt: Timestamp.now() }, { merge: true });
}

/** Cloud Functions retry/logging for `dailyAutomationBatch` is preserved unchanged (the error is
 * always rethrown after reporting) — `reportCriticalError` (§38.2) is a side-channel notification,
 * not a replacement for the existing "let the whole event retry" policy (§17). */
export const dailyAutomationBatch = onSchedule("every 24 hours", async () => {
  try {
    await runDailyAutomationBatch();
  } catch (err) {
    await reportCriticalError({
      merchantId: null,
      source: "dailyAutomationBatch",
      message: err instanceof Error ? err.message : "unknown error",
    });
    throw err;
  }
});

/**
 * System Health self-check (§30, §37.1 note; Phase 9 foundation). Runs independently of
 * `dailyAutomationBatch` so a health check isn't gated on that job's own (potentially long) run.
 *
 * Writes a REAL status for exactly two components this codebase has an honest signal for:
 * - `Database`: a live Firestore round-trip write+read, timed — `DOWN` only if the round trip
 *   itself throws (no invented latency/quota threshold).
 * - `Scheduler`: staleness of the heartbeat `dailyAutomationBatch` writes at the end of its own
 *   run (above) — `DEGRADED` if the last completed run is more than 26 hours old (the job runs
 *   every 24h; 26h is slack, not a business threshold), `UNKNOWN` if it has never run yet.
 *
 * The remaining five named components (§30: LINE, AutomationWorker, Reports, Authentication,
 * ErrorJobs) are written as `UNKNOWN` — deliberately, not a fabricated `OK`/`DEGRADED` — since no
 * metric for any of them is specified anywhere in FINAL-ARCHITECTURE.md and inventing one here
 * would be inventing a business rule (CLAUDE.md §0). Real instrumentation for these is future work
 * (see the Phase 9 implementation report's "remaining known limitations"). `BalanceReconciliation`
 * is excluded from the "uninstrumented" list below — it gets its real status from
 * `balanceReconciliationJob` (§38.4), not from this self-check.
 */
async function runSystemHealthSelfCheck(): Promise<void> {
  const db = getFirestore();
  const now = Timestamp.now();
  const healthCollection = db.collection("systemHealth");

  const dbCheckStart = Date.now();
  let dbStatus: SystemHealthStatus = "OK";
  let dbMessage: string | null = null;
  try {
    const probeRef = healthCollection.doc("__selfCheckProbe__");
    await probeRef.set({ probedAt: now }, { merge: true });
    await probeRef.get();
    dbMessage = `round-trip ${Date.now() - dbCheckStart}ms`;
  } catch (err) {
    dbStatus = "DOWN";
    dbMessage = err instanceof Error ? err.message : "unknown error";
  }
  await healthCollection
    .doc("Database")
    .set({ component: "Database", status: dbStatus, message: dbMessage, lastCheckedAt: now });

  const schedulerSnap = await healthCollection.doc("Scheduler").get();
  const lastSchedulerRunAt = schedulerSnap.exists
    ? (schedulerSnap.data() as { lastCheckedAt?: Timestamp }).lastCheckedAt
    : undefined;
  let schedulerStatus: SystemHealthStatus = "UNKNOWN";
  let schedulerMessage = "dailyAutomationBatch has not reported a completed run yet.";
  if (lastSchedulerRunAt) {
    const hoursSinceLastRun = (now.toMillis() - lastSchedulerRunAt.toMillis()) / (1000 * 60 * 60);
    schedulerStatus = hoursSinceLastRun <= 26 ? "OK" : "DEGRADED";
    schedulerMessage = `last completed run ${hoursSinceLastRun.toFixed(1)}h ago`;
  }
  await healthCollection.doc("Scheduler").set(
    { component: "Scheduler", status: schedulerStatus, message: schedulerMessage, lastCheckedAt: lastSchedulerRunAt ?? null },
    { merge: true },
  );

  const uninstrumented = SYSTEM_HEALTH_COMPONENTS.filter(
    (c) => c !== "Database" && c !== "Scheduler" && c !== "BalanceReconciliation",
  );
  await Promise.all(
    uninstrumented.map((component) =>
      healthCollection.doc(component).set({
        component,
        status: "UNKNOWN" satisfies SystemHealthStatus,
        message: "Not yet instrumented — no metric defined in FINAL-ARCHITECTURE.md §30 for this component.",
        lastCheckedAt: now,
      }),
    ),
  );
}

export const systemHealthSelfCheck = onSchedule("every 15 minutes", async () => {
  try {
    await runSystemHealthSelfCheck();
  } catch (err) {
    await reportCriticalError({
      merchantId: null,
      source: "systemHealthSelfCheck",
      message: err instanceof Error ? err.message : "unknown error",
    });
    throw err;
  }
});

/**
 * Balance Reconciliation Job (§12 Safety Net, §38.4; Phase 10 — implements §12 exactly as
 * already specified, a gap fix, not a new decision). Nightly, independent of
 * `dailyAutomationBatch`. Strictly read-only (see `reconciliation/service.ts`) — never
 * auto-corrects a mismatch. On any mismatch for a merchant, reports ONE critical alert per
 * merchant per run (never per membership, to avoid the alert path itself becoming a flooding
 * vector — §38.2) and writes an aggregate platform-wide status to `systemHealth/BalanceReconciliation`.
 */
export const balanceReconciliationJob = onSchedule("every 24 hours", async () => {
  const db = getFirestore();
  const merchantsSnap = await db.collection("merchants").get();

  let totalMismatches = 0;
  let merchantsWithMismatches = 0;

  for (const merchantDoc of merchantsSnap.docs) {
    const merchantId = merchantDoc.id;
    const mismatches = await findBalanceMismatchesForMerchant(merchantId);
    if (mismatches.length === 0) continue;

    merchantsWithMismatches += 1;
    totalMismatches += mismatches.length;
    await reportCriticalError({
      merchantId,
      source: "balanceReconciliationJob",
      message: `${mismatches.length} membership balance mismatch(es) detected.`,
      context: { mismatchCount: mismatches.length, membershipIds: mismatches.map((m) => m.membershipId) },
    });
  }

  await db
    .collection("systemHealth")
    .doc("BalanceReconciliation")
    .set({
      component: "BalanceReconciliation",
      status: totalMismatches > 0 ? "DEGRADED" : "OK",
      message:
        totalMismatches > 0
          ? `${totalMismatches} mismatch(es) across ${merchantsWithMismatches} merchant(s).`
          : "All balances reconciled.",
      lastCheckedAt: Timestamp.now(),
    });
});
