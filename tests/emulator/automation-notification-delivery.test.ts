import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import {
  createAutomation,
  dryRunAutomation,
  executeAutomationAction,
  getAutomation,
  setAutomationStatus,
} from "@/modules/promotion-automation/service";
import type { UpsertAutomationInput } from "@/modules/promotion-automation/service";
import { updateNotificationSettings } from "@/modules/notification/service";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createMerchantFixture, uniqueId } from "./setup";

/**
 * Phase 6 ↔ Phase 7 integration point: `SEND_NOTIFICATION` now delivers for real (via
 * `NotificationService`/`LineAdapter`, using the actual global `fetch` — network calls are not
 * mocked here since a failure just means the action correctly records FAILED, which this suite
 * asserts on directly rather than requiring a live LINE credential); `NOTIFY_OWNER` remains
 * permanently on the Phase 6 FAILED-seam per the locked "NOTIFY_OWNER Delivery & Broadcast Test
 * Send" decision (§23) — never reinterpreted, never given a delivery path.
 */
async function activate(ownerCtx: Parameters<typeof createAutomation>[0], input: UpsertAutomationInput) {
  const id = await createAutomation(ownerCtx, input);
  await dryRunAutomation(ownerCtx, id);
  await setAutomationStatus(ownerCtx, id, "ACTIVE");
  return getAutomation(ownerCtx, id);
}

describe("SEND_NOTIFICATION via automation — real delivery attempt, not the old always-FAILED seam", () => {
  it("without any linked LINE identity, the action fails with a REAL reason (no member identity), not the old generic 'Phase 7 scope' seam message", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await updateNotificationSettings(ownerCtx, { templates: { PROMOTION: { enabled: true, body: "โปรโมชัน" } }, testRecipientLineUserId: null });
    const automation = await activate(ownerCtx, {
      name: "Send notification test",
      trigger: { type: "MEMBER_CREATED", config: {} },
      conditions: [],
      actions: [{ type: "SEND_NOTIFICATION", params: { templateType: "PROMOTION" } }],
      limits: { maxExecPerCustomerPerDay: null, maxExecPerPromotion: null, pointBudget: null, couponBudget: null, cooldownHours: null },
      presentedAs: "AUTOMATION",
    });
    const membershipId = await createMembership(ownerCtx, { displayName: "No LINE identity" });

    const result = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });
    expect(result.status).toBe("FAILED");

    const execSnap = await getDb()
      .collection(COLLECTIONS.automationActionExecutions)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("automationId", "==", automation.id)
      .get();
    expect(execSnap.docs).toHaveLength(1);
    const reason = (execSnap.docs[0].data() as { failureReason: string | null }).failureReason;
    // The NEW reason is about the member's identity, NOT the old "Phase 7 scope" placeholder text.
    expect(reason).not.toMatch(/Phase 7 scope/);
    expect(reason).toMatch(/LINE identity/i);
  });

  it("is idempotent — the same eventId/action never double-attempts delivery", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await updateNotificationSettings(ownerCtx, { templates: { PROMOTION: { enabled: true, body: "x" } }, testRecipientLineUserId: null });
    const automation = await activate(ownerCtx, {
      name: "Idempotent notify",
      trigger: { type: "MEMBER_CREATED", config: {} },
      conditions: [],
      actions: [{ type: "SEND_NOTIFICATION", params: { templateType: "PROMOTION" } }],
      limits: { maxExecPerCustomerPerDay: null, maxExecPerPromotion: null, pointBudget: null, couponBudget: null, cooldownHours: null },
      presentedAs: "AUTOMATION",
    });
    const membershipId = await createMembership(ownerCtx, { displayName: "Idempotent" });
    const eventId = uniqueId("evt");

    const first = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId });
    const second = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId });
    expect(first.status).toBe("FAILED"); // no LINE identity in this test — still, only ONE attempt
    expect(second.status).toBe("ALREADY_PROCESSED");
  });
});

describe("NOTIFY_OWNER via automation — permanently on the FAILED-seam (locked Phase 7 decision)", () => {
  it("always records FAILED with the Owner/Staff-identity-model reason, never attempts delivery", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const automation = await activate(ownerCtx, {
      name: "Notify owner test",
      trigger: { type: "MEMBER_CREATED", config: {} },
      conditions: [],
      actions: [{ type: "NOTIFY_OWNER", params: {} }],
      limits: { maxExecPerCustomerPerDay: null, maxExecPerPromotion: null, pointBudget: null, couponBudget: null, cooldownHours: null },
      presentedAs: "AUTOMATION",
    });
    const membershipId = await createMembership(ownerCtx, { displayName: "Any member" });

    const result = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });
    expect(result.status).toBe("FAILED");

    const execSnap = await getDb()
      .collection(COLLECTIONS.automationActionExecutions)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("automationId", "==", automation.id)
      .get();
    const reason = (execSnap.docs[0].data() as { failureReason: string | null }).failureReason;
    expect(reason).toMatch(/Owner\/Staff LINE identity/);
  });
});
