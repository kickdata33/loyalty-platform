import { describe, expect, it } from "vitest";

import { createRewardTemplate, listRewardTemplates, setRewardTemplateEnabled } from "@/modules/reward/service";
import { AuthorizationError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";

import { addStaffFixture, createMerchantFixture } from "./setup";

/**
 * Reward Template CRUD — RBAC + tenant isolation (FINAL-ARCHITECTURE.md §9, §13, §33).
 * Mirrors the coverage the Phase 3 Final Review required for `pointRules` after its blocker
 * (unauthenticated/unauthorized/allowed/tenant-isolation/IDOR, at the service layer) — built in
 * from the start here rather than discovered as a gap afterward.
 */

const baseTemplate = { name: "กาแฟฟรี", type: "FREE_PRODUCT" as const, requiredPoints: 100 };

describe("createRewardTemplate — RBAC + server-derived merchantId", () => {
  it("Staff (no REWARD_MANAGE) is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await expect(createRewardTemplate(staff.ctx, baseTemplate)).rejects.toThrow(AuthorizationError);
  });

  it("Manager and Owner (both hold REWARD_MANAGE) can create a template", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    const ownerRewardId = await createRewardTemplate(ownerCtx, { ...baseTemplate, name: "Owner reward" });
    const managerRewardId = await createRewardTemplate(manager.ctx, { ...baseTemplate, name: "Manager reward" });

    const rewards = await listRewardTemplates(ownerCtx);
    expect(rewards.map((r) => r.id)).toEqual(expect.arrayContaining([ownerRewardId, managerRewardId]));
    // `CreateRewardTemplateInput` has no `merchantId` field at all — every created template is
    // stamped with `ctx.merchantId` structurally, not merely by convention (§3, §10).
    expect(rewards.every((r) => r.merchantId === merchantId)).toBe(true);
  });

  it("defaults: enabled=true, stock/limitPerMember=null (unlimited), branchScope=[] (all branches)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const rewardId = await createRewardTemplate(ownerCtx, baseTemplate);
    const [reward] = await listRewardTemplates(ownerCtx);
    expect(reward.id).toBe(rewardId);
    expect(reward).toMatchObject({ enabled: true, stock: null, limitPerMember: null, branchScope: [] });
  });

  it("rejects an invalid type and a non-positive requiredPoints", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createRewardTemplate(ownerCtx, { ...baseTemplate, type: "NOT_A_TYPE" as never }),
    ).rejects.toThrow();
    await expect(createRewardTemplate(ownerCtx, { ...baseTemplate, requiredPoints: 0 })).rejects.toThrow();
    await expect(createRewardTemplate(ownerCtx, { ...baseTemplate, requiredPoints: -5 })).rejects.toThrow();
  });
});

describe("setRewardTemplateEnabled — RBAC + tenant isolation", () => {
  it("Staff (no REWARD_MANAGE) is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const rewardId = await createRewardTemplate(ownerCtx, baseTemplate);

    await expect(setRewardTemplateEnabled(staff.ctx, rewardId, false)).rejects.toThrow(AuthorizationError);
  });

  it("Manager and Owner of the SAME merchant can toggle", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const rewardId = await createRewardTemplate(ownerCtx, baseTemplate);

    await setRewardTemplateEnabled(manager.ctx, rewardId, false);
    expect((await listRewardTemplates(ownerCtx)).find((r) => r.id === rewardId)?.enabled).toBe(false);

    await setRewardTemplateEnabled(ownerCtx, rewardId, true);
    expect((await listRewardTemplates(ownerCtx)).find((r) => r.id === rewardId)?.enabled).toBe(true);
  });

  it("an Owner/Manager of a DIFFERENT merchant cannot enable/disable another merchant's template (TenantIsolationError), and it is left untouched", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const managerB = await addStaffFixture(merchantB.ownerCtx, "MANAGER");
    const rewardId = await createRewardTemplate(merchantA.ownerCtx, baseTemplate);

    await expect(setRewardTemplateEnabled(merchantB.ownerCtx, rewardId, false)).rejects.toThrow(
      TenantIsolationError,
    );
    await expect(setRewardTemplateEnabled(managerB.ctx, rewardId, false)).rejects.toThrow(
      TenantIsolationError,
    );

    const rewardsA = await listRewardTemplates(merchantA.ownerCtx);
    expect(rewardsA.find((r) => r.id === rewardId)?.enabled).toBe(true);
  });

  it("a non-existent rewardId is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(setRewardTemplateEnabled(ownerCtx, "does-not-exist", false)).rejects.toThrow();
  });
});

describe("listRewardTemplates — every role can read; tenant isolation always applies", () => {
  it("Owner, Manager, AND Staff can all list — REWARD_REDEEM is held by every role (§9)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await createRewardTemplate(ownerCtx, baseTemplate);

    await expect(listRewardTemplates(ownerCtx)).resolves.toHaveLength(1);
    await expect(listRewardTemplates(manager.ctx)).resolves.toHaveLength(1);
    await expect(listRewardTemplates(staff.ctx)).resolves.toHaveLength(1);
  });

  it("never returns another merchant's templates", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    await createRewardTemplate(merchantA.ownerCtx, { ...baseTemplate, name: "A reward" });
    await createRewardTemplate(merchantB.ownerCtx, { ...baseTemplate, name: "B reward" });

    const rewardsA = await listRewardTemplates(merchantA.ownerCtx);
    expect(rewardsA).toHaveLength(1);
    expect(rewardsA[0].merchantId).toBe(merchantA.merchantId);
  });
});

/**
 * §13 "Start/End Date", "Voucher Expiration", "Allowed Branches" — closes the Final Review
 * BLOCKER (Reward Template CRUD wasn't wired end to end for these three fields). Covers the
 * service-layer validation now enforced by `createRewardTemplate`.
 */
describe("createRewardTemplate — Start/End Date window (§13)", () => {
  it("accepts a valid date window (startAt in the past, endAt in the future)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const startAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const endAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const rewardId = await createRewardTemplate(ownerCtx, { ...baseTemplate, startAt, endAt });
    const [reward] = await listRewardTemplates(ownerCtx);
    expect(reward.id).toBe(rewardId);
    expect(reward.startAt?.toDate().getTime()).toBe(startAt.getTime());
    expect(reward.endAt?.toDate().getTime()).toBe(endAt.getTime());
  });

  it("rejects an invalid combination — endAt at or before startAt", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const startAt = new Date("2026-06-01");
    const endAtBefore = new Date("2026-05-01");
    const endAtEqual = new Date("2026-06-01");

    await expect(
      createRewardTemplate(ownerCtx, { ...baseTemplate, startAt, endAt: endAtBefore }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createRewardTemplate(ownerCtx, { ...baseTemplate, startAt, endAt: endAtEqual }),
    ).rejects.toThrow(ValidationError);
  });

  it("startAt or endAt alone (no counterpart) is accepted", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createRewardTemplate(ownerCtx, { ...baseTemplate, startAt: new Date(Date.now() - 1000) }),
    ).resolves.toBeTruthy();
    await expect(
      createRewardTemplate(ownerCtx, { ...baseTemplate, endAt: new Date(Date.now() + 1000 * 60 * 60) }),
    ).resolves.toBeTruthy();
  });
});

describe("createRewardTemplate — Voucher Expiration config validation (§13)", () => {
  it("accepts NEVER (default) and DAYS_AFTER_REDEMPTION with a positive integer", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createRewardTemplate(ownerCtx, { ...baseTemplate, voucherExpiryRule: { type: "NEVER" } }),
    ).resolves.toBeTruthy();
    await expect(
      createRewardTemplate(ownerCtx, {
        ...baseTemplate,
        voucherExpiryRule: { type: "DAYS_AFTER_REDEMPTION", days: 14 },
      }),
    ).resolves.toBeTruthy();
  });

  it("rejects DAYS_AFTER_REDEMPTION with a non-positive or non-integer `days`", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createRewardTemplate(ownerCtx, {
        ...baseTemplate,
        voucherExpiryRule: { type: "DAYS_AFTER_REDEMPTION", days: 0 },
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createRewardTemplate(ownerCtx, {
        ...baseTemplate,
        voucherExpiryRule: { type: "DAYS_AFTER_REDEMPTION", days: -5 },
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createRewardTemplate(ownerCtx, {
        ...baseTemplate,
        voucherExpiryRule: { type: "DAYS_AFTER_REDEMPTION", days: 1.5 },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects FIXED_DATE with no date", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      // @ts-expect-error — `date` intentionally omitted to exercise the validation branch.
      createRewardTemplate(ownerCtx, { ...baseTemplate, voucherExpiryRule: { type: "FIXED_DATE" } }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("createRewardTemplate — Allowed Branches / branchScope (§13)", () => {
  it("accepts branchScope containing the caller's own real branch id(s)", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const rewardId = await createRewardTemplate(ownerCtx, { ...baseTemplate, branchScope: [branchId] });
    const [reward] = await listRewardTemplates(ownerCtx);
    expect(reward.id).toBe(rewardId);
    expect(reward.branchScope).toEqual([branchId]);
  });

  it("rejects a forged/nonexistent branch id", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createRewardTemplate(ownerCtx, { ...baseTemplate, branchScope: ["not-a-real-branch-id"] }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a cross-tenant branch id — a real branch belonging to a DIFFERENT merchant", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");

    await expect(
      createRewardTemplate(merchantA.ownerCtx, {
        ...baseTemplate,
        branchScope: [merchantB.branchId], // real branch, but not merchant A's
      }),
    ).rejects.toThrow(ValidationError);

    // Merchant B's own owner using the same real branch id succeeds — confirms the rejection
    // above is about *ownership*, not that the id is malformed.
    await expect(
      createRewardTemplate(merchantB.ownerCtx, { ...baseTemplate, branchScope: [merchantB.branchId] }),
    ).resolves.toBeTruthy();
  });

  it("empty branchScope (default) is always accepted — means all branches", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(createRewardTemplate(ownerCtx, { ...baseTemplate, branchScope: [] })).resolves.toBeTruthy();
  });
});

describe("createRewardTemplate — RBAC still enforced with the new fields present", () => {
  it("Staff is rejected even when startAt/endAt/voucherExpiryRule/branchScope are all supplied", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await expect(
      createRewardTemplate(staff.ctx, {
        ...baseTemplate,
        startAt: new Date(),
        endAt: new Date(Date.now() + 1000 * 60 * 60),
        voucherExpiryRule: { type: "DAYS_AFTER_REDEMPTION", days: 7 },
        branchScope: [branchId],
      }),
    ).rejects.toThrow(AuthorizationError);
  });
});
