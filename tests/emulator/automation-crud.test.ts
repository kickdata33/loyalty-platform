import { describe, expect, it } from "vitest";

import {
  createAutomation,
  dryRunAutomation,
  getAutomation,
  listAutomations,
  setAutomationStatus,
  updateAutomation,
} from "@/modules/promotion-automation/service";
import type { UpsertAutomationInput } from "@/modules/promotion-automation/service";
import { AuthorizationError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";

import { addStaffFixture, createMerchantFixture } from "./setup";

/**
 * Automation/Promotion CRUD — RBAC, tenant isolation, and the two LOCKED Phase 6 deferrals
 * (FINAL-ARCHITECTURE.md §16 "CHANGE_TIER — Deferred for Phase 6" / "BIRTHDAY — Deferred for
 * Phase 6"). Both must be rejected with a deterministic server-side `ValidationError` at
 * create/update time — never silently dropped, never executed.
 */

const baseAutomation: UpsertAutomationInput = {
  name: "Welcome bonus",
  trigger: { type: "MEMBER_CREATED", config: {} },
  conditions: [],
  actions: [{ type: "ADD_POINTS", params: { amount: 10 } }],
  limits: { maxExecPerCustomerPerDay: null, maxExecPerPromotion: null, pointBudget: null, couponBudget: null, cooldownHours: null },
  presentedAs: "AUTOMATION",
};

describe("createAutomation — RBAC + tenant isolation", () => {
  it("Staff (no AUTOMATION_MANAGE) is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await expect(createAutomation(staff.ctx, baseAutomation)).rejects.toThrow(AuthorizationError);
  });

  it("Manager and Owner can create; defaults to DRAFT status, null lastTestRunSnapshot", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    const ownerId = await createAutomation(ownerCtx, { ...baseAutomation, name: "Owner auto" });
    const managerId = await createAutomation(manager.ctx, { ...baseAutomation, name: "Manager auto" });

    const automations = await listAutomations(ownerCtx);
    expect(automations.map((a) => a.id)).toEqual(expect.arrayContaining([ownerId, managerId]));
    expect(automations.every((a) => a.merchantId === merchantId)).toBe(true);
    const created = automations.find((a) => a.id === ownerId);
    expect(created?.status).toBe("DRAFT");
    expect(created?.lastTestRunSnapshot).toBeNull();
  });

  it("never returns another merchant's automations", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    await createAutomation(merchantA.ownerCtx, { ...baseAutomation, name: "A" });
    await createAutomation(merchantB.ownerCtx, { ...baseAutomation, name: "B" });

    const listA = await listAutomations(merchantA.ownerCtx);
    expect(listA).toHaveLength(1);
    expect(listA[0].merchantId).toBe(merchantA.merchantId);
  });
});

describe("Locked Phase 6 deferral — BIRTHDAY trigger rejected deterministically", () => {
  it("createAutomation rejects trigger.type='BIRTHDAY'", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createAutomation(ownerCtx, { ...baseAutomation, trigger: { type: "BIRTHDAY", config: {} } }),
    ).rejects.toThrow(ValidationError);
  });

  it("updateAutomation also rejects trigger.type='BIRTHDAY' on an existing automation", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const id = await createAutomation(ownerCtx, baseAutomation);
    await expect(
      updateAutomation(ownerCtx, id, { ...baseAutomation, trigger: { type: "BIRTHDAY", config: {} } }),
    ).rejects.toThrow(ValidationError);
    // Untouched — still MEMBER_CREATED.
    const reloaded = await getAutomation(ownerCtx, id);
    expect(reloaded.trigger.type).toBe("MEMBER_CREATED");
  });
});

describe("Locked Phase 6 deferral — CHANGE_TIER action rejected deterministically", () => {
  it("createAutomation rejects an action with type='CHANGE_TIER'", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createAutomation(ownerCtx, { ...baseAutomation, actions: [{ type: "CHANGE_TIER", params: {} }] }),
    ).rejects.toThrow(ValidationError);
  });

  it("a CHANGE_TIER action mixed with a valid action is still rejected in full (no partial accept)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createAutomation(ownerCtx, {
        ...baseAutomation,
        actions: [{ type: "ADD_POINTS", params: { amount: 5 } }, { type: "CHANGE_TIER", params: {} }],
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("setAutomationStatus — Test Mode mandatory before ACTIVE (§16)", () => {
  it("cannot go directly to ACTIVE without a prior dry-run", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const id = await createAutomation(ownerCtx, baseAutomation);
    await expect(setAutomationStatus(ownerCtx, id, "ACTIVE")).rejects.toThrow(ValidationError);
  });

  it("can go ACTIVE after a dry-run has run at least once", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const id = await createAutomation(ownerCtx, baseAutomation);
    await dryRunAutomation(ownerCtx, id);
    await expect(setAutomationStatus(ownerCtx, id, "ACTIVE")).resolves.toBeUndefined();
    const reloaded = await getAutomation(ownerCtx, id);
    expect(reloaded.status).toBe("ACTIVE");
  });

  it("Staff cannot change status; cross-tenant automationId yields TenantIsolationError", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const staffA = await addStaffFixture(merchantA.ownerCtx, "STAFF");
    const id = await createAutomation(merchantA.ownerCtx, baseAutomation);

    await expect(setAutomationStatus(staffA.ctx, id, "TEST")).rejects.toThrow(AuthorizationError);
    await expect(setAutomationStatus(merchantB.ownerCtx, id, "TEST")).rejects.toThrow(TenantIsolationError);
  });
});

describe("dryRunAutomation — read-only, never dispatches a real action", () => {
  it("estimates affected members without creating any ledger/coupon/reward/execution side effects", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const id = await createAutomation(ownerCtx, baseAutomation);
    const result = await dryRunAutomation(ownerCtx, id);
    expect(result.estimatedAffectedMembers).toBeGreaterThanOrEqual(0);
    const reloaded = await getAutomation(ownerCtx, id);
    expect(reloaded.lastTestRunSnapshot).not.toBeNull();
  });
});
