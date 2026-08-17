import { describe, expect, it } from "vitest";

import { GET as getStaff } from "@/app/api/staff/route";
import { getEmergencyControls, setEmergencyControl } from "@/modules/emergency-control/service";
import { createMembership } from "@/modules/membership/service";
import { addManualPoints, adjustPoints } from "@/modules/points/ledger-service";
import {
  createAutomation,
  dryRunAutomation,
  executeAutomationAction,
  getAutomation,
  setAutomationStatus,
} from "@/modules/promotion-automation/service";
import { createRewardTemplate, redeemReward } from "@/modules/reward/service";
import { sendBroadcast, sendTestBroadcast, updateNotificationSettings } from "@/modules/notification/service";
import type { ChannelAdapter } from "@/modules/notification/adapters/channel-adapter";
import { ServiceSuspendedError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createMerchantFixture, createSuperAdminFixture, idTokenFor, jsonRequest, uniqueId } from "./setup";

const noopAdapter: ChannelAdapter = { send: async () => {} };

describe("Emergency Control — setEmergencyControl (§37.2)", () => {
  it("requires a non-empty reason to change a toggle", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    await expect(
      setEmergencyControl(admin.ctx, merchantId, "pointsEngineFrozen", true, ""),
    ).rejects.toThrow(ValidationError);
  });

  it("a merchant with no emergencyControls document has every capability enabled by default", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const record = await getEmergencyControls(admin.ctx, merchantId);
    expect(record).toMatchObject({
      staffSuspended: false,
      pointsEngineFrozen: false,
      automationDisabled: false,
      broadcastDisabled: false,
    });
  });

  it("toggling a capability for merchant A never affects merchant B (tenant isolation)", async () => {
    const admin = await createSuperAdminFixture();
    const merchantA = await createMerchantFixture("Emergency A");
    const merchantB = await createMerchantFixture("Emergency B");

    await setEmergencyControl(admin.ctx, merchantA.merchantId, "pointsEngineFrozen", true, "investigate A");

    const controlsA = await getEmergencyControls(admin.ctx, merchantA.merchantId);
    const controlsB = await getEmergencyControls(admin.ctx, merchantB.merchantId);
    expect(controlsA.pointsEngineFrozen).toBe(true);
    expect(controlsB.pointsEngineFrozen).toBe(false);
  });
});

describe("Emergency Control — staffSuspended blocks the single Staff/Owner auth choke point", () => {
  it("GET /api/staff is rejected once staffSuspended is enabled, and works again once lifted", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx } = await createMerchantFixture();
    const token = await idTokenFor(ownerCtx.authUid);

    const before = await getStaff(jsonRequest("http://localhost/api/staff", { token }));
    expect(before.status).toBe(200);

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "staffSuspended", true, "suspected abuse");
    const during = await getStaff(jsonRequest("http://localhost/api/staff", { token }));
    expect(during.status).toBe(503);

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "staffSuspended", false, "cleared");
    const after = await getStaff(jsonRequest("http://localhost/api/staff", { token }));
    expect(after.status).toBe(200);
  });
});

describe("Emergency Control — pointsEngineFrozen blocks every points-ledger-creating write", () => {
  it("blocks addManualPoints, and blocks even a reversal, while frozen", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "Frozen Member" });

    const earn = await addManualPoints(ownerCtx, {
      membershipId,
      branchId: null,
      amount: 10,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "pointsEngineFrozen", true, "suspected FIFO bug");

    await expect(
      addManualPoints(ownerCtx, {
        membershipId,
        branchId: null,
        amount: 5,
        reason: "should be blocked",
        idempotencyKey: uniqueId("frozen-add"),
      }),
    ).rejects.toThrow(ServiceSuspendedError);

    await expect(
      adjustPoints(ownerCtx, {
        membershipId,
        delta: -1,
        reason: "should be blocked",
        idempotencyKey: uniqueId("frozen-adjust"),
      }),
    ).rejects.toThrow(ServiceSuspendedError);

    // Deliberate: even a reversal of a PRE-EXISTING ledger entry is blocked while frozen (§37.2 —
    // "freeze หมายถึงหยุดการเคลื่อนไหวแต้มทั้งหมดชั่วคราว").
    const { reversePoints } = await import("@/modules/points/ledger-service");
    await expect(
      reversePoints(ownerCtx, {
        ledgerEntryId: earn.ledgerEntryId,
        reason: "should be blocked",
        idempotencyKey: uniqueId("frozen-reverse"),
      }),
    ).rejects.toThrow(ServiceSuspendedError);

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "pointsEngineFrozen", false, "cleared");
    await expect(
      addManualPoints(ownerCtx, {
        membershipId,
        branchId: null,
        amount: 5,
        reason: "should succeed now",
        idempotencyKey: uniqueId("unfrozen-add"),
      }),
    ).resolves.toMatchObject({ delta: 5 });
  });

  it("blocks reward redemption (a points spend) while frozen", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await createRewardTemplate(ownerCtx, { name: "Frozen reward", type: "FREE_PRODUCT", requiredPoints: 5 });
    const membershipId = await createMembership(ownerCtx, { displayName: "Frozen Redeemer" });
    await addManualPoints(ownerCtx, { membershipId, branchId: null, amount: 10, reason: "seed", idempotencyKey: uniqueId("seed") });

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "pointsEngineFrozen", true, "investigate");

    await expect(
      redeemReward(ownerCtx, {
        membershipId,
        rewardTemplateId: rewardId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("frozen-redeem"),
      }),
    ).rejects.toThrow(ServiceSuspendedError);
  });

  it("also blocks automation's ADD_POINTS action while frozen (single choke point covers system-triggered writes too)", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx } = await createMerchantFixture();
    const automationId = await createAutomation(ownerCtx, {
      name: "Frozen automation",
      trigger: { type: "MEMBER_CREATED", config: {} },
      conditions: [],
      actions: [{ type: "ADD_POINTS", params: { amount: 20 } }],
      limits: { maxExecPerCustomerPerDay: null, maxExecPerPromotion: null, pointBudget: null, couponBudget: null, cooldownHours: null },
      presentedAs: "AUTOMATION",
    });
    await dryRunAutomation(ownerCtx, automationId);
    await setAutomationStatus(ownerCtx, automationId, "ACTIVE");
    const automation = await getAutomation(ownerCtx, automationId);
    const membershipId = await createMembership(ownerCtx, { displayName: "Automation Frozen Member" });

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "pointsEngineFrozen", true, "investigate");

    const result = await executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") });
    expect(result.status).toBe("FAILED");

    const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
    expect((snap.data() as { pointsBalance: number }).pointsBalance).toBe(0);
  });
});

describe("Emergency Control — automationDisabled blocks the single automation execution choke point", () => {
  it("blocks executeAutomationAction entirely (not just points-related actions)", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx } = await createMerchantFixture();
    const automationId = await createAutomation(ownerCtx, {
      name: "Disableable automation",
      trigger: { type: "MEMBER_CREATED", config: {} },
      conditions: [],
      actions: [{ type: "ADD_TAG", params: { tag: "vip" } }],
      limits: { maxExecPerCustomerPerDay: null, maxExecPerPromotion: null, pointBudget: null, couponBudget: null, cooldownHours: null },
      presentedAs: "AUTOMATION",
    });
    await dryRunAutomation(ownerCtx, automationId);
    await setAutomationStatus(ownerCtx, automationId, "ACTIVE");
    const automation = await getAutomation(ownerCtx, automationId);
    const membershipId = await createMembership(ownerCtx, { displayName: "Disabled Automation Member" });

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "automationDisabled", true, "investigate runaway automation");

    await expect(
      executeAutomationAction({ automation, actionIndex: 0, membershipId, eventId: uniqueId("evt") }),
    ).rejects.toThrow(ServiceSuspendedError);
  });
});

describe("Emergency Control — broadcastDisabled blocks sendBroadcast/sendTestBroadcast only", () => {
  it("blocks sendBroadcast and sendTestBroadcast while enabled", async () => {
    const admin = await createSuperAdminFixture();
    const { ownerCtx } = await createMerchantFixture();
    await updateNotificationSettings(ownerCtx, {
      templates: { PROMOTION: { enabled: true, body: "hello {{name}}" } },
      testRecipientLineUserId: "U_test_recipient",
    });

    await setEmergencyControl(admin.ctx, ownerCtx.merchantId, "broadcastDisabled", true, "investigate spam report");

    await expect(
      sendBroadcast(ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, noopAdapter),
    ).rejects.toThrow(ServiceSuspendedError);
    await expect(sendTestBroadcast(ownerCtx, "test body", noopAdapter)).rejects.toThrow(ServiceSuspendedError);
  });
});
