import { describe, expect, it } from "vitest";

import { GET as getMerchant } from "@/app/api/merchant/route";
import { PATCH as patchBranding } from "@/app/api/merchant/branding/route";
import { POST as postMerchants } from "@/app/api/merchants/route";
import { POST as postStaff } from "@/app/api/staff/route";
import { createMerchantWithOwner } from "@/modules/merchant/service";
import { syncStaffCustomClaims } from "@/modules/rbac/staff-claims";

import { createTestClientUser, getFreshIdToken } from "./client-auth";
import { createMerchantFixture, getAdminAuth, idTokenFor, jsonRequest, uniqueSlug } from "./setup";

/**
 * Tests the locked Phase 2 Architecture Decision (FINAL-ARCHITECTURE.md §8, "Staff/Owner API
 * Authentication Transport") end to end, invoking the real exported Next.js Route Handlers
 * directly (no dev server needed — a Route Handler is just an async function of `Request`) with
 * REAL Firebase ID Tokens minted by the Auth emulator.
 */
describe("Staff API authentication transport (emulator, real tokens)", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await getMerchant(jsonRequest("http://localhost/api/merchant"));
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header (no token after 'Bearer')", async () => {
    const res = await getMerchant(
      jsonRequest("http://localhost/api/merchant", { headers: { authorization: "Bearer" } }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong-scheme Authorization header", async () => {
    const res = await getMerchant(
      jsonRequest("http://localhost/api/merchant", {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an invalid (garbage) bearer token", async () => {
    const res = await getMerchant(
      jsonRequest("http://localhost/api/merchant", {
        headers: { authorization: "Bearer not-a-real-jwt-at-all" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token even though the JWT itself hasn't expired", async () => {
    const user = await createTestClientUser("revoke-test");
    const result = await createMerchantWithOwner({
      name: "Revoke Test Shop",
      slug: uniqueSlug("revoke"),
      businessType: "cafe",
      timezone: "Asia/Bangkok",
      ownerAuthUid: user.uid,
    });
    await syncStaffCustomClaims(getAdminAuth(), {
      staffUserId: result.staffUserId,
      before: null,
      after: {
        merchantId: result.merchantId,
        authUid: user.uid,
        role: "OWNER",
        status: "ACTIVE",
        branchScope: [],
      },
    });

    const token = await getFreshIdToken(user);

    const before = await getMerchant(jsonRequest("http://localhost/api/merchant", { token }));
    expect(before.status).toBe(200);

    // Firebase's revocation check (`tokensValidAfterTime`) has 1-second granularity — a token
    // minted in the same wall-clock second as the revocation call isn't reliably caught. Real
    // test suites for this feature universally need this gap; it reflects a platform
    // characteristic, not something this codebase's `checkRevoked: true` wiring can work around.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await getAdminAuth().revokeRefreshTokens(user.uid);

    const after = await getMerchant(jsonRequest("http://localhost/api/merchant", { token }));
    expect(after.status).toBe(401);
  });

  it("onboarding (POST /api/merchants) ignores any forged ownerAuthUid/uid in the body — always uses the verified token's uid", async () => {
    const user = await createTestClientUser("forge-onboard");
    const token = await getFreshIdToken(user);

    const res = await postMerchants(
      jsonRequest("http://localhost/api/merchants", {
        method: "POST",
        token,
        json: {
          name: "Forged Owner Shop",
          slug: uniqueSlug("forged"),
          businessType: "cafe",
          timezone: "Asia/Bangkok",
          // Neither of these fields is ever read — createMerchantWithOwner only ever uses
          // `decoded.uid` from the verified token.
          ownerAuthUid: "someone-elses-uid",
          uid: "someone-elses-uid",
        },
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { staffUserId: string };
    expect(body.staffUserId).toBeTruthy();
  });

  it("PATCH /api/merchant/branding ignores a forged merchantId in the body — always scoped to the caller's own merchant", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const token = await idTokenFor(merchantA.ownerAuthUid);

    const res = await patchBranding(
      jsonRequest("http://localhost/api/merchant/branding", {
        method: "PATCH",
        token,
        // merchantB's id is in the body, but the route never reads a merchantId from the body at
        // all — it's always ctx.merchantId (merchant A's).
        json: { primaryColor: "#123456", merchantId: merchantB.merchantId },
      }),
    );

    expect(res.status).toBe(200);
  });

  it("PATCH /api/merchant/branding rejects a javascript:/non-http(s) logoUrl — found during Phase 2 security review", async () => {
    const merchant = await createMerchantFixture();
    const token = await idTokenFor(merchant.ownerAuthUid);

    const res = await patchBranding(
      jsonRequest("http://localhost/api/merchant/branding", {
        method: "PATCH",
        token,
        json: { logoUrl: "javascript:alert(1)" },
      }),
    );

    expect(res.status).toBe(400);
  });

  it("POST /api/staff ignores a forged authUid/staffUserId in the body — target resolved by email lookup only", async () => {
    const merchant = await createMerchantFixture();
    const newStaffUser = await createTestClientUser("staff-target");
    const token = await idTokenFor(merchant.ownerAuthUid);

    const res = await postStaff(
      jsonRequest("http://localhost/api/staff", {
        method: "POST",
        token,
        json: {
          email: newStaffUser.email,
          role: "STAFF",
          authUid: "forged-uid",
          staffUserId: "forged-staff-id",
        },
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { staffUserId: string };
    expect(body.staffUserId).not.toBe("forged-staff-id");
  });
});
