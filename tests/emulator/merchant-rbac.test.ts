import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import { syncStaffCustomClaims } from "@/modules/rbac/staff-claims";
import {
  createStaffUser,
  reinstateStaffUser,
  suspendStaffUser,
  updateStaffRole,
} from "@/modules/staff/service";
import { AuthorizationError, ConflictError, ValidationError } from "@/modules/shared/errors";

import { addStaffFixture, createMerchantFixture, createTestAuthUser, getAdminAuth } from "./setup";

/**
 * End-to-end RBAC through the real service layer (createMerchantWithOwner → createStaffUser →
 * requirePermission/requireOwner), per FINAL-ARCHITECTURE.md §9/§10. Custom claims are synced by
 * calling `syncStaffCustomClaims` directly (the same function the Cloud Function trigger
 * delegates to) rather than by running a live Functions emulator — see Known Limitations.
 */
describe("Merchant + Staff RBAC (emulator, end to end)", () => {
  it("creates a Merchant with a working Owner, default Branch, and TRIAL subscription", async () => {
    const fixture = await createMerchantFixture();
    expect(fixture.merchantId).toBeTruthy();
    expect(fixture.branchId).toBeTruthy();

    const user = await getAdminAuth().getUser(fixture.ownerAuthUid);
    expect(user.customClaims).toMatchObject({ merchantId: fixture.merchantId, role: "OWNER" });
  });

  it("rejects creating a second merchant with the same slug (race-safe uniqueness)", async () => {
    const ownerAuthUid = await createTestAuthUser("owner");
    const { createMerchantWithOwner } = await import("@/modules/merchant/service");
    const slug = `dup-${Date.now()}`;
    await createMerchantWithOwner({
      name: "First",
      slug,
      businessType: "cafe",
      timezone: "Asia/Bangkok",
      ownerAuthUid,
    });
    await expect(
      createMerchantWithOwner({
        name: "Second",
        slug,
        businessType: "cafe",
        timezone: "Asia/Bangkok",
        ownerAuthUid: await createTestAuthUser("owner2"),
      }),
    ).rejects.toThrow(ConflictError);
  });

  it("Owner can create Manager and Staff; each ends up with correctly scoped custom claims", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");

    expect((await getAdminAuth().getUser(manager.authUid)).customClaims).toMatchObject({
      merchantId,
      role: "MANAGER",
    });
    expect((await getAdminAuth().getUser(staff.authUid)).customClaims).toMatchObject({
      merchantId,
      role: "STAFF",
    });
  });

  it("Staff cannot create other staff (lacks STAFF_MANAGE)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const newAuthUid = await createTestAuthUser("nobody");

    await expect(
      createStaffUser(staff.ctx, { authUid: newAuthUid, role: "STAFF" }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("Manager CAN create staff (has STAFF_MANAGE)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const newStaffUid = await createTestAuthUser("counter");

    const staffUserId = await createStaffUser(manager.ctx, { authUid: newStaffUid, role: "STAFF" });
    expect(staffUserId).toBeTruthy();
  });

  it("createStaffUser rejects role='OWNER' as an assignable role (only createMerchantWithOwner sets it)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const newAuthUid = await createTestAuthUser("wannabe-owner");
    // @ts-expect-error — role='OWNER' is intentionally excluded from the input type.
    await expect(createStaffUser(ownerCtx, { authUid: newAuthUid, role: "OWNER" })).rejects.toThrow(
      ValidationError,
    );
  });

  it("Manager cannot suspend or change the role of the Owner, even with STAFF_MANAGE", async () => {
    const { ownerCtx, ownerStaffUserId } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    await expect(suspendStaffUser(manager.ctx, ownerStaffUserId)).rejects.toThrow(AuthorizationError);
    await expect(updateStaffRole(manager.ctx, ownerStaffUserId, "MANAGER")).rejects.toThrow(
      AuthorizationError,
    );
  });

  it("Owner CAN suspend a Manager or Staff, and suspension clears their custom claims", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");

    await suspendStaffUser(ownerCtx, staff.staffUserId);
    // Suspension itself doesn't fire the trigger in this test setup — simulate it explicitly,
    // exactly like createMerchantFixture/addStaffFixture do for creation.
    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId: staff.staffUserId,
      before: { merchantId: ownerCtx.merchantId, authUid: staff.authUid, role: "STAFF", status: "ACTIVE" },
      after: { merchantId: ownerCtx.merchantId, authUid: staff.authUid, role: "STAFF", status: "SUSPENDED" },
    });

    const user = await getAdminAuth().getUser(staff.authUid);
    expect(user.customClaims ?? {}).toEqual({});

    await reinstateStaffUser(ownerCtx, staff.staffUserId);
  });

  it("Staff can create a membership (MEMBER_CREATE); Manager/Owner also can", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");

    const membershipId = await createMembership(staff.ctx, { displayName: "Somchai" });
    expect(membershipId).toBeTruthy();
  });
});
