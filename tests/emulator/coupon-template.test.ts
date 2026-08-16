import { describe, expect, it } from "vitest";

import { createCouponTemplate, listCouponTemplates, setCouponTemplateEnabled } from "@/modules/coupon/service";
import { AuthorizationError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";

import { addStaffFixture, createMerchantFixture } from "./setup";

/**
 * Coupon Template CRUD — RBAC + tenant isolation + condition validation (FINAL-ARCHITECTURE.md
 * §9, §14, §33, and the locked Phase 5 Architecture Decisions on Usage Limit/Expiration). Built in
 * from the start with full field coverage (name/type/conditions incl. Start/End, Valid Days/Hours,
 * Branch, Total/Per-Member Limit, Expiry, Stackable) — the exact class of gap (fields validated
 * server-side but never wired end to end) that blocked Reward's Phase 4 Final Review once already.
 */

const baseTemplate = { name: "ส่วนลด 50 บาท", type: "FIXED_DISCOUNT" as const };

describe("createCouponTemplate — RBAC + server-derived merchantId", () => {
  it("Staff (no COUPON_MANAGE) is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await expect(createCouponTemplate(staff.ctx, baseTemplate)).rejects.toThrow(AuthorizationError);
  });

  it("Manager and Owner (both hold COUPON_MANAGE) can create a template", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    const ownerCouponId = await createCouponTemplate(ownerCtx, { ...baseTemplate, name: "Owner coupon" });
    const managerCouponId = await createCouponTemplate(manager.ctx, { ...baseTemplate, name: "Manager coupon" });

    const coupons = await listCouponTemplates(ownerCtx);
    expect(coupons.map((c) => c.id)).toEqual(expect.arrayContaining([ownerCouponId, managerCouponId]));
    // `CreateCouponTemplateInput` has no `merchantId` field at all — structural guarantee (§3, §10).
    expect(coupons.every((c) => c.merchantId === merchantId)).toBe(true);
  });

  it("defaults: enabled=true, conditions.totalLimit/limitPerMember=null, branchScope=[], validDaysOfWeek=[], validTimeRange=null, stackable=false, expiryRule=NEVER", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await createCouponTemplate(ownerCtx, baseTemplate);
    const [coupon] = await listCouponTemplates(ownerCtx);
    expect(coupon.id).toBe(couponId);
    expect(coupon.enabled).toBe(true);
    expect(coupon.conditions).toMatchObject({
      totalLimit: null,
      limitPerMember: null,
      branchScope: [],
      validDaysOfWeek: [],
      validTimeRange: null,
      stackable: false,
      expiryRule: { type: "NEVER" },
    });
  });

  it("rejects an invalid type", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, type: "NOT_A_TYPE" as never }),
    ).rejects.toThrow();
  });
});

describe("createCouponTemplate — Start/End Date window (§14)", () => {
  it("accepts a valid window and rejects endAt at or before startAt", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, {
        ...baseTemplate,
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    ).resolves.toBeTruthy();

    const startAt = new Date("2026-06-01");
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, startAt, endAt: new Date("2026-05-01") }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, startAt, endAt: new Date("2026-06-01") }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("createCouponTemplate — Expiration config validation (locked Phase 5 decision: lazy only)", () => {
  it("accepts NEVER (default) and DAYS_AFTER_ISSUANCE with a positive integer", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, expiryRule: { type: "NEVER" } }),
    ).resolves.toBeTruthy();
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, expiryRule: { type: "DAYS_AFTER_ISSUANCE", days: 14 } }),
    ).resolves.toBeTruthy();
  });

  it("rejects DAYS_AFTER_ISSUANCE with a non-positive or non-integer `days`", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, expiryRule: { type: "DAYS_AFTER_ISSUANCE", days: 0 } }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, expiryRule: { type: "DAYS_AFTER_ISSUANCE", days: -1 } }),
    ).rejects.toThrow(ValidationError);
  });
});

describe("createCouponTemplate — Valid Days/Hours condition input validation (§14)", () => {
  it("rejects out-of-range validDaysOfWeek entries", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, validDaysOfWeek: [7] }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, validDaysOfWeek: [-1] }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a malformed validTimeRange", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, validTimeRange: { start: "9am", end: "17:00" } }),
    ).rejects.toThrow(ValidationError);
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, validTimeRange: { start: "17:00", end: "09:00" } }),
    ).rejects.toThrow(ValidationError); // end before start
  });

  it("accepts a valid validDaysOfWeek/validTimeRange", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, {
        ...baseTemplate,
        validDaysOfWeek: [1, 2, 3, 4, 5],
        validTimeRange: { start: "09:00", end: "17:00" },
      }),
    ).resolves.toBeTruthy();
  });
});

describe("createCouponTemplate — Allowed Branches / branchScope (§14)", () => {
  it("accepts branchScope containing the caller's own real branch id(s)", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const couponId = await createCouponTemplate(ownerCtx, { ...baseTemplate, branchScope: [branchId] });
    const [coupon] = await listCouponTemplates(ownerCtx);
    expect(coupon.id).toBe(couponId);
    expect(coupon.conditions.branchScope).toEqual([branchId]);
  });

  it("rejects a forged/nonexistent branch id", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      createCouponTemplate(ownerCtx, { ...baseTemplate, branchScope: ["not-a-real-branch-id"] }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a cross-tenant branch id — a real branch belonging to a DIFFERENT merchant", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");

    await expect(
      createCouponTemplate(merchantA.ownerCtx, { ...baseTemplate, branchScope: [merchantB.branchId] }),
    ).rejects.toThrow(ValidationError);

    await expect(
      createCouponTemplate(merchantB.ownerCtx, { ...baseTemplate, branchScope: [merchantB.branchId] }),
    ).resolves.toBeTruthy();
  });
});

describe("setCouponTemplateEnabled — RBAC + tenant isolation", () => {
  it("Staff (no COUPON_MANAGE) is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const couponId = await createCouponTemplate(ownerCtx, baseTemplate);

    await expect(setCouponTemplateEnabled(staff.ctx, couponId, false)).rejects.toThrow(AuthorizationError);
  });

  it("Manager and Owner of the SAME merchant can toggle", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const couponId = await createCouponTemplate(ownerCtx, baseTemplate);

    await setCouponTemplateEnabled(manager.ctx, couponId, false);
    expect((await listCouponTemplates(ownerCtx)).find((c) => c.id === couponId)?.enabled).toBe(false);

    await setCouponTemplateEnabled(ownerCtx, couponId, true);
    expect((await listCouponTemplates(ownerCtx)).find((c) => c.id === couponId)?.enabled).toBe(true);
  });

  it("an Owner/Manager of a DIFFERENT merchant cannot enable/disable another merchant's template (TenantIsolationError), and it is left untouched", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const managerB = await addStaffFixture(merchantB.ownerCtx, "MANAGER");
    const couponId = await createCouponTemplate(merchantA.ownerCtx, baseTemplate);

    await expect(setCouponTemplateEnabled(merchantB.ownerCtx, couponId, false)).rejects.toThrow(
      TenantIsolationError,
    );
    await expect(setCouponTemplateEnabled(managerB.ctx, couponId, false)).rejects.toThrow(TenantIsolationError);

    const couponsA = await listCouponTemplates(merchantA.ownerCtx);
    expect(couponsA.find((c) => c.id === couponId)?.enabled).toBe(true);
  });

  it("a non-existent couponId is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(setCouponTemplateEnabled(ownerCtx, "does-not-exist", false)).rejects.toThrow();
  });
});

describe("listCouponTemplates — every role can read; tenant isolation always applies", () => {
  it("Owner, Manager, AND Staff can all list — COUPON_REDEEM is held by every role (§9)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await createCouponTemplate(ownerCtx, baseTemplate);

    await expect(listCouponTemplates(ownerCtx)).resolves.toHaveLength(1);
    await expect(listCouponTemplates(manager.ctx)).resolves.toHaveLength(1);
    await expect(listCouponTemplates(staff.ctx)).resolves.toHaveLength(1);
  });

  it("never returns another merchant's templates", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    await createCouponTemplate(merchantA.ownerCtx, { ...baseTemplate, name: "A coupon" });
    await createCouponTemplate(merchantB.ownerCtx, { ...baseTemplate, name: "B coupon" });

    const couponsA = await listCouponTemplates(merchantA.ownerCtx);
    expect(couponsA).toHaveLength(1);
    expect(couponsA[0].merchantId).toBe(merchantA.merchantId);
  });
});
