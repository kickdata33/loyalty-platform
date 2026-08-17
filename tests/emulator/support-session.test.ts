import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import { addManualPoints } from "@/modules/points/ledger-service";
import {
  closeSupportSession,
  getSupportSnapshot,
  openSupportSession,
  resolveSupportSession,
} from "@/modules/support-session/service";
import { AuthenticationError, AuthorizationError, ConflictError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createMerchantFixture, createSuperAdminFixture, uniqueId } from "./setup";

/**
 * Support Session (§37.1, Phase 9 Blocker 1, Locked — Option A). Covers: mandatory reason,
 * ownership scoping (one Super Admin cannot use another's session), deterministic revocation,
 * expiry, strict merchant scoping of the read-only snapshot, and audit attribution.
 */
describe("Support Session — open/close/resolve (emulator)", () => {
  it("requires a non-empty reason to open a session", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    await expect(
      openSupportSession(admin.ctx, { merchantId, reason: "   " }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects opening a session for a merchant that doesn't exist", async () => {
    const admin = await createSuperAdminFixture();
    await expect(
      openSupportSession(admin.ctx, { merchantId: "does-not-exist", reason: "investigate" }),
    ).rejects.toThrow();
  });

  it("a session can be resolved by the Super Admin who opened it, and read-back returns the correct merchantId", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const { sessionId } = await openSupportSession(admin.ctx, { merchantId, reason: "customer reported a bug" });

    const resolved = await resolveSupportSession(admin.ctx, sessionId);
    expect(resolved.merchantId).toBe(merchantId);
    expect(resolved.superAdminUid).toBe(admin.authUid);
  });

  it("a DIFFERENT Super Admin cannot resolve/use someone else's session", async () => {
    const adminA = await createSuperAdminFixture();
    const adminB = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const { sessionId } = await openSupportSession(adminA.ctx, { merchantId, reason: "investigate" });

    await expect(resolveSupportSession(adminB.ctx, sessionId)).rejects.toThrow(AuthorizationError);
    await expect(closeSupportSession(adminB.ctx, sessionId)).rejects.toThrow(AuthorizationError);
  });

  it("closing a session revokes it deterministically — a closed session can never be resolved again", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const { sessionId } = await openSupportSession(admin.ctx, { merchantId, reason: "investigate" });

    await closeSupportSession(admin.ctx, sessionId);
    await expect(resolveSupportSession(admin.ctx, sessionId)).rejects.toThrow(AuthenticationError);
    // Closing an already-closed session is a distinguishable error, not silently accepted.
    await expect(closeSupportSession(admin.ctx, sessionId)).rejects.toThrow(ConflictError);
  });

  it("an expired session is rejected even though its revokedAt is still null", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const { sessionId } = await openSupportSession(admin.ctx, { merchantId, reason: "investigate", ttlMinutes: 1 });

    // Simulate expiry deterministically instead of sleeping in a test.
    await getDb().collection(COLLECTIONS.supportSessions).doc(sessionId).update({
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(resolveSupportSession(admin.ctx, sessionId)).rejects.toThrow(AuthenticationError);
  });

  it("an unknown sessionId fails closed", async () => {
    const admin = await createSuperAdminFixture();
    await expect(resolveSupportSession(admin.ctx, "does-not-exist")).rejects.toThrow(AuthenticationError);
  });

  it("opening a session writes an audited entry attributed to the real Super Admin identity", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const { sessionId } = await openSupportSession(admin.ctx, { merchantId, reason: "customer reported a bug" });

    const auditSnap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("merchantId", "==", merchantId)
      .where("action", "==", "support_session.opened")
      .where("targetId", "==", sessionId)
      .get();
    expect(auditSnap.size).toBe(1);
    const entry = auditSnap.docs[0].data() as { actorType: string; actorId: string };
    expect(entry.actorType).toBe("superAdmin");
    expect(entry.actorId).toBe(admin.authUid);
  });
});

describe("Support Session — snapshot is strictly merchant-scoped and read-only (§37.1)", () => {
  it("the snapshot for merchant A's session never includes merchant B's data", async () => {
    const admin = await createSuperAdminFixture();
    const merchantA = await createMerchantFixture("Support A");
    const merchantB = await createMerchantFixture("Support B");

    const memberA = await createMembership(merchantA.ownerCtx, { displayName: "Member A" });
    await addManualPoints(merchantA.ownerCtx, {
      membershipId: memberA,
      branchId: null,
      amount: 15,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });
    const memberB = await createMembership(merchantB.ownerCtx, { displayName: "Member B" });
    await addManualPoints(merchantB.ownerCtx, {
      membershipId: memberB,
      branchId: null,
      amount: 999,
      reason: "seed",
      idempotencyKey: uniqueId("seed"),
    });

    const { sessionId } = await openSupportSession(admin.ctx, { merchantId: merchantA.merchantId, reason: "investigate A" });
    const snapshot = await getSupportSnapshot(admin.ctx, sessionId);

    expect(snapshot.merchantId).toBe(merchantA.merchantId);
    expect(snapshot.recentPointsLedger.every((e) => e.membershipId !== memberB)).toBe(true);
    expect(snapshot.recentPointsLedger.some((e) => e.membershipId === memberA)).toBe(true);
    // The delta unique to merchant B's seed (999) must never leak into merchant A's snapshot.
    expect(snapshot.recentPointsLedger.some((e) => e.delta === 999)).toBe(false);
  });

  it("a revoked/expired session cannot be used to view a snapshot", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const { sessionId } = await openSupportSession(admin.ctx, { merchantId, reason: "investigate" });
    await closeSupportSession(admin.ctx, sessionId);

    await expect(getSupportSnapshot(admin.ctx, sessionId)).rejects.toThrow(AuthenticationError);
  });

  it("viewing a snapshot is itself audited", async () => {
    const admin = await createSuperAdminFixture();
    const { merchantId } = await createMerchantFixture();
    const { sessionId } = await openSupportSession(admin.ctx, { merchantId, reason: "investigate" });
    await getSupportSnapshot(admin.ctx, sessionId);

    const auditSnap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("merchantId", "==", merchantId)
      .where("action", "==", "support_session.snapshot_viewed")
      .get();
    expect(auditSnap.size).toBeGreaterThanOrEqual(1);
  });
});
