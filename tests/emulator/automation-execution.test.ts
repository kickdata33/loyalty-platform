import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import {
  createAutomation,
  dispatchEventToAutomations,
  dryRunAutomation,
  executeAutomationAction,
  getAutomation,
  setAutomationStatus,
} from "@/modules/promotion-automation/service";
import type { UpsertAutomationInput } from "@/modules/promotion-automation/service";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createMerchantFixture, uniqueId } from "./setup";

/**
 * Automation execution: real-time dispatch, transactional safety limits, idempotency, event/
 * audit consistency, and the SEND_NOTIFICATION/NOTIFY_OWNER Phase 6 seam (FINAL-ARCHITECTURE.md
 * §16, §17, §23). `dispatchEventToAutomations`/`executeAutomationAction` are called directly here
 * (the same functions the `onEventCreate` Cloud Function and the scheduled batch call — no
 * separate test-only code path) rather than through the Functions emulator, matching this
 * codebase's established precedent (`syncStaffCustomClaims` in `staff-claims.test.ts`).
 */

const addPointsAutomation: UpsertAutomationInput = {
  name: "Welcome bonus",
  trigger: { type: "MEMBER_CREATED", config: {} },
  conditions: [],
  actions: [{ type: "ADD_POINTS", params: { amount: 15 } }],
  limits: { maxExecPerCustomerPerDay: null, maxExecPerPromotion: null, pointBudget: null, couponBudget: null, cooldownHours: null },
  presentedAs: "PROMOTION",
  marketing: { title: "Welcome", description: "First-visit bonus", bannerImageUrl: null, visibleInCustomerPortal: false },
};

async function activate(ownerCtx: Parameters<typeof createAutomation>[0], input: UpsertAutomationInput) {
  const id = await createAutomation(ownerCtx, input);
  await dryRunAutomation(ownerCtx, id);
  await setAutomationStatus(ownerCtx, id, "ACTIVE");
  return getAutomation(ownerCtx, id);
}

describe("dispatchEventToAutomations — real-time ADD_POINTS end to end", () => {
  it("MEMBER_CREATED fires an ACTIVE matching automation and credits points atomically", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await activate(ownerCtx, addPointsAutomation);

    const membershipId = await createMembership(ownerCtx, { displayName: "New Member" });
    await dispatchEventToAutomations({
      id: uniqueId("evt"),
      merchantId,
      type: "membership.created",
      membershipId,
    });

    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(15);

    const eventsSnap = await getDb()
      .collection(COLLECTIONS.events)
      .where("merchantId", "==", merchantId)
      .where("type", "==", "promotion.triggered")
      .get();
    expect(eventsSnap.docs).toHaveLength(1);
  });

  it("a PAUSED automation never fires", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const automation = await activate(ownerCtx, addPointsAutomation);
    await setAutomationStatus(ownerCtx, automation.id, "PAUSED");

    const membershipId = await createMembership(ownerCtx, { displayName: "No Bonus" });
    await dispatchEventToAutomations({ id: uniqueId("evt"), merchantId, type: "membership.created", membershipId });

    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(0);
  });

  it("never fires for a different merchant's automation, even with the same trigger type", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    await activate(merchantA.ownerCtx, addPointsAutomation);

    const membershipId = await createMembership(merchantB.ownerCtx, { displayName: "B Member" });
    await dispatchEventToAutomations({
      id: uniqueId("evt"),
      merchantId: merchantB.merchantId,
      type: "membership.created",
      membershipId,
    });

    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(0);
  });
});

describe("executeAutomationAction — idempotency (same executionKey never double-executes)", () => {
  it("calling the exact same action twice for the same eventId only credits points once", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const automation = await activate(ownerCtx, addPointsAutomation);
    const membershipId = await createMembership(ownerCtx, { displayName: "Idempotent" });
    const eventId = uniqueId("evt");

    const first = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId });
    const second = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId });

    expect(first.status).toBe("EXECUTED");
    expect(second.status).toBe("ALREADY_PROCESSED");
    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(15); // not 30
    void merchantId;
  });
});

describe("executeAutomationAction — safety limits enforced (§16, §26)", () => {
  it("maxExecPerCustomerPerDay=1 blocks a second execution the same day for the same member", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const automation = await activate(ownerCtx, {
      ...addPointsAutomation,
      limits: { ...addPointsAutomation.limits, maxExecPerCustomerPerDay: 1 },
    });
    const membershipId = await createMembership(ownerCtx, { displayName: "Limited" });

    const first = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });
    const second = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });

    expect(first.status).toBe("EXECUTED");
    expect(second.status).toBe("SKIPPED_LIMIT");
    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(15); // only the first counted
  });

  it("pointBudget=0 blocks ADD_POINTS entirely, recorded SKIPPED_LIMIT not silently ignored", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const automation = await activate(ownerCtx, {
      ...addPointsAutomation,
      limits: { ...addPointsAutomation.limits, pointBudget: 0 },
    });
    const membershipId = await createMembership(ownerCtx, { displayName: "No Budget" });

    const result = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });
    expect(result.status).toBe("SKIPPED_LIMIT");
    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(0);
  });
});

describe("ADD_TAG action", () => {
  it("appends the configured tag to the membership", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const automation = await activate(ownerCtx, {
      ...addPointsAutomation,
      actions: [{ type: "ADD_TAG", params: { tag: "welcomed" } }],
    });
    const membershipId = await createMembership(ownerCtx, { displayName: "Tagged" });

    await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });
    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { tags: string[] }).tags).toContain("welcomed");
  });
});

describe("SEND_NOTIFICATION / NOTIFY_OWNER — Phase 6 seam only, never real delivery (§23, §33)", () => {
  it("is idempotently recorded as FAILED with a clear reason, never as EXECUTED", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const automation = await activate(ownerCtx, {
      ...addPointsAutomation,
      actions: [{ type: "SEND_NOTIFICATION", params: {} }],
    });
    const membershipId = await createMembership(ownerCtx, { displayName: "Notify Me" });

    const result = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });
    expect(result.status).toBe("FAILED");

    const execSnap = await getDb()
      .collection(COLLECTIONS.automationActionExecutions)
      .where("merchantId", "==", automation.merchantId)
      .where("automationId", "==", automation.id)
      .get();
    expect(execSnap.docs).toHaveLength(1);
    const data = execSnap.docs[0].data() as { status: string; failureReason: string | null };
    expect(data.status).toBe("FAILED");
    expect(data.failureReason).toMatch(/Phase 7/);
  });
});

describe("Cross-tenant safety: executeAutomationAction never touches another merchant's membership", () => {
  it("throws (via loadMembershipForMerchantTx's TenantIsolationError) for a cross-tenant membershipId on ADD_POINTS", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    const automation = await activate(merchantA.ownerCtx, addPointsAutomation);
    const membershipB = await createMembership(merchantB.ownerCtx, { displayName: "Cross tenant" });

    await expect(
      executeAutomationAction({ automation, actionIndex: 0, membershipId: membershipB, eventId: uniqueId("evt") }),
    ).rejects.toThrow();
  });
});
