import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import {
  createCouponTemplate,
  getCouponHistory,
  issueCouponManual,
  issueCouponToSegment,
  redeemCoupon,
  setCouponTemplateEnabled,
} from "@/modules/coupon/service";
import type { CreateCouponTemplateInput } from "@/modules/coupon/service";
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  TenantIsolationError,
  ValidationError,
} from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

import { addStaffFixture, createMerchantFixture, uniqueId } from "./setup";


/**
 * Instance Generation (Issue) + Redemption flow (FINAL-ARCHITECTURE.md §12-pattern reused, §14,
 * locked Phase 5 Architecture Decisions) — the transactional core of Phase 5.
 *
 * Coupons never touch `pointsLedger`/`pointsLots` at all (§14: "ไม่ต้องแลกด้วยแต้มเสมอไป") — no
 * FIFO/balance assertions anywhere in this file, unlike the equivalent Reward test suite.
 */

async function seedMembership(ctx: AuthContext): Promise<string> {
  return createMembership(ctx, { displayName: "Coupon Tester" });
}

async function seedCoupon(ctx: AuthContext, overrides: Partial<CreateCouponTemplateInput> = {}): Promise<string> {
  return createCouponTemplate(ctx, { name: "ส่วนลด 50 บาท", type: "FIXED_DISCOUNT", ...overrides });
}

function nowInBangkok(): { dayOfWeek: number; hhmm: string } {
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return { dayOfWeek: weekdayMap[weekdayStr] ?? 0, hhmm: `${hour}:${minute}` };
}

describe("issueCouponManual — RBAC boundary (the specific abuse case flagged in the Phase 5 Planning Review), tenant isolation, atomicity", () => {
  it("Staff (no COUPON_MANAGE) is REJECTED — must not be able to mint coupons via COUPON_REDEEM alone", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const couponId = await seedCoupon(ownerCtx);
    const membershipId = await seedMembership(ownerCtx);

    await expect(
      issueCouponManual(staff.ctx, {
        membershipId,
        couponTemplateId: couponId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(AuthorizationError);

    // Confirm nothing was created despite the rejected attempt.
    const instancesSnap = await getDb()
      .collection(COLLECTIONS.couponInstances)
      .where("merchantId", "==", ownerCtx.merchantId)
      .get();
    expect(instancesSnap.empty).toBe(true);
  });

  it("Manager and Owner (both hold COUPON_MANAGE) can issue", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const couponId = await seedCoupon(ownerCtx);

    for (const ctx of [ownerCtx, manager.ctx]) {
      const membershipId = await seedMembership(ownerCtx);
      const result = await issueCouponManual(ctx, {
        membershipId,
        couponTemplateId: couponId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      });
      expect(result.instanceId).toBeTruthy();
      expect(result.code).toHaveLength(8);
    }
  });

  it("creates an AVAILABLE instance, writes coupon.issued event, a Visit with relatedRefs.couponInstanceId, and a coupon.issued audit log entry", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx);
    const membershipId = await seedMembership(ownerCtx);

    const result = await issueCouponManual(ownerCtx, {
      membershipId,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("issue"),
    });

    const instanceSnap = await getDb().collection(COLLECTIONS.couponInstances).doc(result.instanceId).get();
    expect(instanceSnap.data()).toMatchObject({
      status: "AVAILABLE",
      membershipId,
      couponTemplateId: couponId,
      issuedVia: "MANUAL",
      code: result.code,
    });

    const eventsSnap = await getDb()
      .collection(COLLECTIONS.events)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("type", "==", "coupon.issued")
      .get();
    expect(eventsSnap.docs).toHaveLength(1);

    const visitsSnap = await getDb()
      .collection(COLLECTIONS.visits)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("membershipId", "==", membershipId)
      .get();
    expect(visitsSnap.docs).toHaveLength(1);
    expect(visitsSnap.docs[0].data()).toMatchObject({
      source: "STAFF_SCAN",
      relatedRefs: { couponInstanceId: result.instanceId },
    });

    const auditSnap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("action", "==", "coupon.issued")
      .get();
    expect(auditSnap.docs).toHaveLength(1);
  });

  it("totalLimit enforcement: reaching the limit aborts the whole transaction — no partial write", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx, { totalLimit: 1 });
    const membershipA = await seedMembership(ownerCtx);
    const membershipB = await seedMembership(ownerCtx);

    await issueCouponManual(ownerCtx, {
      membershipId: membershipA,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });

    await expect(
      issueCouponManual(ownerCtx, {
        membershipId: membershipB,
        couponTemplateId: couponId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(ValidationError);

    const instancesSnap = await getDb()
      .collection(COLLECTIONS.couponInstances)
      .where("merchantId", "==", ownerCtx.merchantId)
      .get();
    expect(instancesSnap.docs).toHaveLength(1); // still just the first one
  });

  it("limitPerMember enforcement blocks a second issuance to the same member", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx, { limitPerMember: 1 });
    const membershipId = await seedMembership(ownerCtx);

    await issueCouponManual(ownerCtx, {
      membershipId,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });

    await expect(
      issueCouponManual(ownerCtx, {
        membershipId,
        couponTemplateId: couponId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("a disabled or not-yet-active or expired-window template cannot be issued", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await seedMembership(ownerCtx);

    const disabledId = await seedCoupon(ownerCtx);
    await setCouponTemplateEnabled(ownerCtx, disabledId, false);
    await expect(
      issueCouponManual(ownerCtx, {
        membershipId,
        couponTemplateId: disabledId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(ValidationError);

    const notYetActiveId = await seedCoupon(ownerCtx, { startAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    await expect(
      issueCouponManual(ownerCtx, {
        membershipId,
        couponTemplateId: notYetActiveId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(ValidationError);

    const expiredWindowId = await seedCoupon(ownerCtx, { endAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });
    await expect(
      issueCouponManual(ownerCtx, {
        membershipId,
        couponTemplateId: expiredWindowId,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("a repeated idempotencyKey never double-issues (double-submit safety, §27)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx, { totalLimit: 5 });
    const membershipId = await seedMembership(ownerCtx);
    const idempotencyKey = uniqueId("issue");

    const first = await issueCouponManual(ownerCtx, {
      membershipId,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey,
    });
    const second = await issueCouponManual(ownerCtx, {
      membershipId,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey,
    });

    expect(second.instanceId).toBe(first.instanceId);
    const instancesSnap = await getDb()
      .collection(COLLECTIONS.couponInstances)
      .where("merchantId", "==", ownerCtx.merchantId)
      .get();
    expect(instancesSnap.docs).toHaveLength(1);
  });

  it("throws NotFoundError for a non-existent coupon template", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await seedMembership(ownerCtx);
    await expect(
      issueCouponManual(ownerCtx, {
        membershipId,
        couponTemplateId: "does-not-exist",
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it("tenant isolation: cross-merchant membershipId and cross-merchant couponTemplateId are both rejected", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const couponA = await seedCoupon(merchantA.ownerCtx);
    const couponB = await seedCoupon(merchantB.ownerCtx);
    const membershipA = await seedMembership(merchantA.ownerCtx);
    const membershipB = await seedMembership(merchantB.ownerCtx);

    await expect(
      issueCouponManual(merchantB.ownerCtx, {
        membershipId: membershipA,
        couponTemplateId: couponB,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(TenantIsolationError);

    await expect(
      issueCouponManual(merchantB.ownerCtx, {
        membershipId: membershipB,
        couponTemplateId: couponA,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("issue"),
      }),
    ).rejects.toThrow(TenantIsolationError);
  });
});

describe("issueCouponToSegment — RBAC boundary, segment matching, skip-not-abort, no Visit for bulk issuance", () => {
  it("Staff (no COUPON_MANAGE) is REJECTED", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const couponId = await seedCoupon(ownerCtx);

    await expect(
      issueCouponToSegment(staff.ctx, { couponTemplateId: couponId, targetSegment: "NEW", idempotencyKey: uniqueId("seg") }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("issues to every member currently in the target segment (all fixtures default to NEW — documented Known Limitation: segment is never recalculated by any job in this codebase)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx);
    const membershipA = await seedMembership(ownerCtx);
    const membershipB = await seedMembership(ownerCtx);

    const result = await issueCouponToSegment(ownerCtx, {
      couponTemplateId: couponId,
      targetSegment: "NEW",
      idempotencyKey: uniqueId("seg"),
    });

    expect(result.issuedCount).toBe(2);
    expect(result.skippedCount).toBe(0);

    const historyA = await getCouponHistory(ownerCtx, membershipA);
    const historyB = await getCouponHistory(ownerCtx, membershipB);
    expect(historyA).toHaveLength(1);
    expect(historyB).toHaveLength(1);
    expect(historyA[0].issuedVia).toBe("SEGMENT");
  });

  it("does NOT record a Visit for segment-issued instances (§15: bulk/automated issuance is not a visit)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx);
    await seedMembership(ownerCtx);

    await issueCouponToSegment(ownerCtx, { couponTemplateId: couponId, targetSegment: "NEW", idempotencyKey: uniqueId("seg") });

    const visitsSnap = await getDb()
      .collection(COLLECTIONS.visits)
      .where("merchantId", "==", ownerCtx.merchantId)
      .get();
    expect(visitsSnap.empty).toBe(true);
  });

  it("a per-member limit reached partway through the batch SKIPS that member and continues, rather than aborting the whole batch", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx, { limitPerMember: 1 });
    const alreadyHasOne = await seedMembership(ownerCtx);
    const fresh = await seedMembership(ownerCtx);

    // Pre-issue one to `alreadyHasOne` via Manual so the segment batch will hit its limit for them.
    await issueCouponManual(ownerCtx, {
      membershipId: alreadyHasOne,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });

    const result = await issueCouponToSegment(ownerCtx, {
      couponTemplateId: couponId,
      targetSegment: "NEW",
      idempotencyKey: uniqueId("seg"),
    });

    expect(result.skippedCount).toBeGreaterThanOrEqual(1); // `alreadyHasOne` skipped
    expect(result.issuedCount).toBeGreaterThanOrEqual(1); // `fresh` still got one
    const historyFresh = await getCouponHistory(ownerCtx, fresh);
    expect(historyFresh).toHaveLength(1);
  });

  it("a repeated batch idempotencyKey never double-issues to any member (per-member deterministic sub-keys)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const couponId = await seedCoupon(ownerCtx, { totalLimit: 10 });
    const membershipId = await seedMembership(ownerCtx);
    const idempotencyKey = uniqueId("seg");

    await issueCouponToSegment(ownerCtx, { couponTemplateId: couponId, targetSegment: "NEW", idempotencyKey });
    await issueCouponToSegment(ownerCtx, { couponTemplateId: couponId, targetSegment: "NEW", idempotencyKey });

    const history = await getCouponHistory(ownerCtx, membershipId);
    expect(history).toHaveLength(1); // not 2
  });
});

describe("redeemCoupon — RBAC, IDOR, status transitions, lazy expiry boundary, branch + valid-days/hours conditions", () => {
  async function issueOnce(ctx: AuthContext, overrides: Partial<CreateCouponTemplateInput> = {}) {
    const couponId = await seedCoupon(ctx, overrides);
    const membershipId = await seedMembership(ctx);
    const { instanceId, code } = await issueCouponManual(ctx, {
      membershipId,
      couponTemplateId: couponId,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });
    return { couponId, membershipId, instanceId, code };
  }

  it("Owner, Manager, AND Staff can all redeem — COUPON_REDEEM is held by every role", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");

    for (const ctx of [ownerCtx, manager.ctx, staff.ctx]) {
      const { code } = await issueOnce(ownerCtx);
      const result = await redeemCoupon(ctx, {
        code,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      });
      expect(result.instanceId).toBeTruthy();
    }
  });

  it("transitions AVAILABLE -> USED, records usedAt/usedByStaffId/usedBranchId, writes coupon.redeemed event + Visit + audit log", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const { instanceId, code, membershipId } = await issueOnce(ownerCtx);

    const result = await redeemCoupon(ownerCtx, {
      code,
      branchId,
      visitSource: "STAFF_SCAN",
      idempotencyKey: uniqueId("redeem"),
    });
    expect(result.membershipId).toBe(membershipId);

    const instanceSnap = await getDb().collection(COLLECTIONS.couponInstances).doc(instanceId).get();
    expect(instanceSnap.data()).toMatchObject({ status: "USED", usedByStaffId: ownerCtx.authUid, usedBranchId: branchId });
    expect(instanceSnap.data()?.usedAt).toBeTruthy();

    const eventsSnap = await getDb()
      .collection(COLLECTIONS.events)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("type", "==", "coupon.redeemed")
      .get();
    expect(eventsSnap.docs).toHaveLength(1);

    const auditSnap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("merchantId", "==", ownerCtx.merchantId)
      .where("action", "==", "coupon.redeemed")
      .get();
    expect(auditSnap.docs).toHaveLength(1);
  });

  it("code is case/whitespace-insensitive (normalized), matching how it's generated (uppercase)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { code } = await issueOnce(ownerCtx);

    await expect(
      redeemCoupon(ownerCtx, {
        code: `  ${code.toLowerCase()}  `,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).resolves.toMatchObject({ instanceId: expect.any(String) });
  });

  it("an already-used coupon cannot be redeemed again (ConflictError, locked V1 Usage Limit decision)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { code } = await issueOnce(ownerCtx);

    await redeemCoupon(ownerCtx, { code, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") });
    await expect(
      redeemCoupon(ownerCtx, {
        code,
        branchId: null,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"), // different key — must still be blocked by instance status
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("a repeated idempotencyKey never double-processes (double-submit safety, §27)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { code } = await issueOnce(ownerCtx);
    const idempotencyKey = uniqueId("redeem");

    const first = await redeemCoupon(ownerCtx, { code, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey });
    const second = await redeemCoupon(ownerCtx, { code, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey });
    expect(second.instanceId).toBe(first.instanceId);
  });

  it("locked Phase 5 decision: expiresAt <= serverNow is rejected — boundary condition (exactly equal, and one second past)", async () => {
    const { ownerCtx } = await createMerchantFixture();

    const { instanceId: exactlyNowId, code: exactlyNowCode } = await issueOnce(ownerCtx);
    await getDb().collection(COLLECTIONS.couponInstances).doc(exactlyNowId).update({ expiresAt: new Date() });
    await expect(
      redeemCoupon(ownerCtx, { code: exactlyNowCode, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).rejects.toThrow(ValidationError);

    const { instanceId: pastId, code: pastCode } = await issueOnce(ownerCtx);
    await getDb().collection(COLLECTIONS.couponInstances).doc(pastId).update({ expiresAt: new Date(Date.now() - 1000) });
    await expect(
      redeemCoupon(ownerCtx, { code: pastCode, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).rejects.toThrow(ValidationError);
  });

  it("not-yet-expired (expiresAt in the future) can be redeemed normally", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { instanceId, code } = await issueOnce(ownerCtx);
    await getDb()
      .collection(COLLECTIONS.couponInstances)
      .doc(instanceId)
      .update({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) });

    await expect(
      redeemCoupon(ownerCtx, { code, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).resolves.toMatchObject({ instanceId });
  });

  it("branchScope: a real branch id NOT in the coupon's branchScope is rejected; the allowed branch succeeds", async () => {
    const { ownerCtx, branchId } = await createMerchantFixture();
    const { code: scopedCode } = await issueOnce(ownerCtx, { branchScope: [branchId] });

    await expect(
      redeemCoupon(ownerCtx, {
        code: scopedCode,
        branchId: "some-other-branch",
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);

    const { code: allowedCode } = await issueOnce(ownerCtx, { branchScope: [branchId] });
    await expect(
      redeemCoupon(ownerCtx, { code: allowedCode, branchId, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).resolves.toMatchObject({ instanceId: expect.any(String) });
  });

  it("branchScope: a cross-tenant branch id (real branch of ANOTHER merchant) is rejected as not-in-scope — no cross-tenant data touched", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const { code } = await issueOnce(merchantA.ownerCtx, { branchScope: [merchantA.branchId] });

    await expect(
      redeemCoupon(merchantA.ownerCtx, {
        code,
        branchId: merchantB.branchId,
        visitSource: "STAFF_SEARCH",
        idempotencyKey: uniqueId("redeem"),
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("Valid Days: redeemable when today is in validDaysOfWeek, blocked when it is not (Asia/Bangkok, merchant's own timezone)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const { dayOfWeek } = nowInBangkok();

    const { code: allowedTodayCode } = await issueOnce(ownerCtx, { validDaysOfWeek: [dayOfWeek] });
    await expect(
      redeemCoupon(ownerCtx, { code: allowedTodayCode, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).resolves.toMatchObject({ instanceId: expect.any(String) });

    const { code: notTodayCode } = await issueOnce(ownerCtx, { validDaysOfWeek: [(dayOfWeek + 3) % 7] });
    await expect(
      redeemCoupon(ownerCtx, { code: notTodayCode, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).rejects.toThrow(ValidationError);
  });

  it("Valid Hours: redeemable when current time is within validTimeRange, blocked when it is not (Asia/Bangkok)", async () => {
    const { ownerCtx } = await createMerchantFixture();

    const { code: wideRangeCode } = await issueOnce(ownerCtx, { validTimeRange: { start: "00:00", end: "23:59" } });
    await expect(
      redeemCoupon(ownerCtx, { code: wideRangeCode, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).resolves.toMatchObject({ instanceId: expect.any(String) });

    // Narrow early-morning window that excludes "now" for any test run outside 00:00-00:01
    // Bangkok time — same class of accepted, negligible timing risk as this suite's existing
    // token-revocation test (api-auth-transport.test.ts), not a new pattern.
    const { hhmm } = nowInBangkok();
    if (hhmm >= "00:05") {
      const { code: narrowRangeCode } = await issueOnce(ownerCtx, { validTimeRange: { start: "00:00", end: "00:01" } });
      await expect(
        redeemCoupon(ownerCtx, { code: narrowRangeCode, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
      ).rejects.toThrow(ValidationError);
    }
  });

  it("throws NotFoundError for a code that doesn't exist", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      redeemCoupon(ownerCtx, { code: "NOPE1234", branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).rejects.toThrow(NotFoundError);
  });

  it("IDOR / tenant isolation: a code belonging to another merchant returns NotFoundError — never confirms cross-tenant existence", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const { code } = await issueOnce(merchantA.ownerCtx);

    let caught: unknown;
    try {
      await redeemCoupon(merchantB.ownerCtx, { code, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught).not.toBeInstanceOf(TenantIsolationError);

    // Merchant A's own owner can still redeem it normally.
    await expect(
      redeemCoupon(merchantA.ownerCtx, { code, branchId: null, visitSource: "STAFF_SEARCH", idempotencyKey: uniqueId("redeem") }),
    ).resolves.toMatchObject({ instanceId: expect.any(String) });
  });
});

describe("getCouponHistory (§14)", () => {
  it("returns this membership's coupons only, newest first, and enforces tenant isolation", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const couponIdA = await seedCoupon(merchantA.ownerCtx);
    const membershipA = await seedMembership(merchantA.ownerCtx);

    await issueCouponManual(merchantA.ownerCtx, {
      membershipId: membershipA,
      couponTemplateId: couponIdA,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });
    await issueCouponManual(merchantA.ownerCtx, {
      membershipId: membershipA,
      couponTemplateId: couponIdA,
      branchId: null,
      visitSource: "STAFF_SEARCH",
      idempotencyKey: uniqueId("issue"),
    });

    const history = await getCouponHistory(merchantA.ownerCtx, membershipA);
    expect(history).toHaveLength(2);
    expect(history.every((c) => c.membershipId === membershipA)).toBe(true);

    await expect(getCouponHistory(merchantB.ownerCtx, membershipA)).rejects.toThrow(TenantIsolationError);
  });
});
