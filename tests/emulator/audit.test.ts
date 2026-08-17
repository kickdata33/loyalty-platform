import { describe, expect, it } from "vitest";

import { setMerchantSubscription } from "@/modules/billing-entitlement/service";
import { createMembership } from "@/modules/membership/service";
import { createBranch } from "@/modules/merchant/service";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { createStaffUser, suspendStaffUser } from "@/modules/staff/service";

import { addStaffFixture, createMerchantFixture, createSuperAdminFixture, createTestAuthUser } from "./setup";

/**
 * Audit integrity (FINAL-ARCHITECTURE.md §18): every business-sensitive write in this module set
 * produces a corresponding append-only auditLogs entry, written server-side. Client-side
 * immutability (no update/delete, ever, from any role) is covered by
 * `tests/security-rules/firestore-rules.test.ts` — this file proves the *writer* is actually
 * invoked and records aim at the right merchant.
 */
describe("Audit trail for Phase 1 sensitive operations (emulator)", () => {
  async function auditEntriesFor(merchantId: string, action: string) {
    const snap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("merchantId", "==", merchantId)
      .where("action", "==", action)
      .get();
    return snap.docs.map((d) => d.data());
  }

  it("records merchant.created when a merchant is created", async () => {
    const { merchantId } = await createMerchantFixture();
    const entries = await auditEntriesFor(merchantId, "merchant.created");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ merchantId, actorType: "system" });
  });

  it("records branch.created", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    // Entitlement Limit Enforcement (§37.3, Phase 9, Locked) — the default trial branchLimit is 1
    // and `createMerchantWithOwner` already creates one default branch, so a second branch needs
    // an explicit override to exercise this test's own actual subject (audit logging), same as
    // any real merchant would need to upgrade first.
    const admin = await createSuperAdminFixture();
    await setMerchantSubscription(admin.ctx, merchantId, { overrides: { branchLimit: 2 }, reason: "test fixture" });
    await createBranch(ownerCtx, { merchantId, name: "สาขา 2", address: "" });
    const entries = await auditEntriesFor(merchantId, "branch.created");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: "staff", actorId: ownerCtx.authUid });
  });

  it("records staff.created and staff.suspended with before/after", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const newAuthUid = await createTestAuthUser("counter");
    const staffUserId = await createStaffUser(ownerCtx, { authUid: newAuthUid, role: "STAFF" });

    const created = await auditEntriesFor(merchantId, "staff.created");
    expect(created).toHaveLength(1);

    await suspendStaffUser(ownerCtx, staffUserId);
    const suspended = await auditEntriesFor(merchantId, "staff.suspended");
    expect(suspended).toHaveLength(1);
    expect(suspended[0]).toMatchObject({
      before: { status: "ACTIVE" },
      after: { status: "SUSPENDED" },
    });
  });

  it("records membership.created", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await createMembership(ownerCtx, { displayName: "Somchai" });
    const entries = await auditEntriesFor(merchantId, "membership.created");
    expect(entries).toHaveLength(1);
  });

  it("audit entries never leak across merchants", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    await createMembership(merchantA.ownerCtx, { displayName: "A member" });
    await createMembership(merchantB.ownerCtx, { displayName: "B member" });

    const entriesA = await auditEntriesFor(merchantA.merchantId, "membership.created");
    expect(entriesA).toHaveLength(1);
    expect(entriesA[0]).toMatchObject({ merchantId: merchantA.merchantId });
  });

  it("staff without STAFF_MANAGE cannot write staffUsers, so no audit entry is created", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const forgedUid = await createTestAuthUser("nobody");

    await expect(
      createStaffUser(staff.ctx, { authUid: forgedUid, role: "STAFF" }),
    ).rejects.toThrow();

    // Only the fixture's own staff.created entry should exist (for `staff` itself) — the
    // rejected attempt above must not have produced a second one.
    const entries = await auditEntriesFor(merchantId, "staff.created");
    expect(entries).toHaveLength(1);
  });
});
