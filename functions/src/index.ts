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
 */
export const onEventCreate = onDocumentCreated("events/{eventId}", async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data() as {
    merchantId: string;
    type: DomainEventType;
    membershipId?: string;
  };
  await dispatchEventToAutomations({
    id: event.params.eventId,
    merchantId: data.merchantId,
    type: data.type,
    membershipId: data.membershipId,
  });
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
export const dailyAutomationBatch = onSchedule("every 24 hours", async () => {
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
          await memberDoc.ref.update({ "activityStats.segment": nextSegment });
        }
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
});
