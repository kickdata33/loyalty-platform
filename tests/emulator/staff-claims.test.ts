import { describe, expect, it } from "vitest";

import { syncStaffCustomClaims } from "@/modules/rbac/staff-claims";

import { createTestAuthUser, getAdminAuth, idTokenFor, uniqueId } from "./setup";

/**
 * Directly exercises the ONE function that sets staff custom claims (§8/§10/§32). In production
 * this only ever runs via the `onStaffUserWrite` Cloud Function trigger (`functions/src/index.ts`)
 * — see Known Limitations in the Phase 1 report for why the trigger itself isn't fired through a
 * live Functions emulator in this suite; this test proves the shared logic the trigger delegates
 * to is correct.
 */
describe("syncStaffCustomClaims (emulator)", () => {
  it("sets merchantId/role/staffUserId/branchScope claims when a staff doc is created ACTIVE", async () => {
    const authUid = await createTestAuthUser("owner");
    const staffUserId = uniqueId("staff");
    const merchantId = uniqueId("merchant");

    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: null,
      after: { merchantId, authUid, role: "OWNER", status: "ACTIVE", branchScope: [] },
    });

    const user = await getAdminAuth().getUser(authUid);
    expect(user.customClaims).toEqual({ merchantId, role: "OWNER", staffUserId, branchScope: [] });
  });

  it("updates claims when role/branchScope change while remaining ACTIVE", async () => {
    const authUid = await createTestAuthUser("staff");
    const staffUserId = uniqueId("staff");
    const merchantId = uniqueId("merchant");

    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: null,
      after: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: ["branch-1"] },
    });
    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: ["branch-1"] },
      after: { merchantId, authUid, role: "MANAGER", status: "ACTIVE", branchScope: [] },
    });

    const user = await getAdminAuth().getUser(authUid);
    expect(user.customClaims).toEqual({ merchantId, role: "MANAGER", staffUserId, branchScope: [] });
  });

  it("clears all custom claims when a staff doc is suspended", async () => {
    const authUid = await createTestAuthUser("staff");
    const staffUserId = uniqueId("staff");
    const merchantId = uniqueId("merchant");

    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: null,
      after: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: [] },
    });
    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: [] },
      after: { merchantId, authUid, role: "STAFF", status: "SUSPENDED", branchScope: [] },
    });

    const user = await getAdminAuth().getUser(authUid);
    expect(user.customClaims ?? {}).toEqual({});
  });

  it("revokes an already-issued token on suspend — found during Phase 2 security review: clearing claims alone leaves a live token valid (with stale claims) until its natural expiry", async () => {
    const authUid = await createTestAuthUser("staff");
    const staffUserId = uniqueId("staff");
    const merchantId = uniqueId("merchant");

    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: null,
      after: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: [] },
    });

    // Mint a real ID Token *before* suspension — this is the token a still-logged-in browser tab
    // would be holding at the moment of suspension.
    const tokenIssuedBeforeSuspend = await idTokenFor(authUid);
    await expect(
      getAdminAuth().verifyIdToken(tokenIssuedBeforeSuspend, /* checkRevoked */ true),
    ).resolves.toMatchObject({ uid: authUid });

    // Firebase's revocation check (`tokensValidAfterTime`) has 1-second granularity — a token
    // minted in the same wall-clock second as the revocation call isn't reliably caught. Real
    // test suites for this feature universally need this gap; it reflects a platform
    // characteristic, not something `syncStaffCustomClaims`'s revocation call can work around.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: [] },
      after: { merchantId, authUid, role: "STAFF", status: "SUSPENDED", branchScope: [] },
    });

    // The pre-suspend token must now be rejected — not just missing claims, actually revoked.
    await expect(
      getAdminAuth().verifyIdToken(tokenIssuedBeforeSuspend, /* checkRevoked */ true),
    ).rejects.toThrow();
  });

  it("clears all custom claims when a staff doc is deleted", async () => {
    const authUid = await createTestAuthUser("staff");
    const staffUserId = uniqueId("staff");
    const merchantId = uniqueId("merchant");

    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: null,
      after: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: [] },
    });
    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId,
      before: { merchantId, authUid, role: "STAFF", status: "ACTIVE", branchScope: [] },
      after: null,
    });

    const user = await getAdminAuth().getUser(authUid);
    expect(user.customClaims ?? {}).toEqual({});
  });
});
