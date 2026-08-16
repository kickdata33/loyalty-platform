import { describe, expect, it } from "vitest";

import { GET as getMemberByCode } from "@/app/api/members/by-code/[code]/route";
import { GET as getMembersSearch } from "@/app/api/members/search/route";
import { PATCH as patchPointsRuleEnabled } from "@/app/api/points-rules/[ruleId]/enabled/route";
import { GET as getPointsRules, POST as postPointsRules } from "@/app/api/points-rules/route";
import { createMembership, getMembership, getMembershipByCode, searchMemberships } from "@/modules/membership/service";
import { createPointRule, listPointRules, setPointRuleEnabled } from "@/modules/points/rule-engine";
import { AuthorizationError, NotFoundError, TenantIsolationError } from "@/modules/shared/errors";

import { addStaffFixture, createMerchantFixture, idTokenFor, jsonRequest } from "./setup";

/**
 * Closes the Phase 3 Final Review BLOCKER: `createPointRule`/`setPointRuleEnabled`/`listPointRules`
 * (§11, §33 "pointRules config UI") and `searchMemberships`/`getMembershipByCode` (§33 "Staff Scan
 * flow, Search Member flow") had zero automated RBAC/tenant-isolation coverage, unlike every other
 * merchant-scoped resource in this codebase (memberships, staff, merchants, subscriptions, and all
 * 4 points-ledger operations). This file covers, per function: unauthorized role, allowed role,
 * tenant isolation / IDOR, and that authorization is always derived from the server-verified
 * `AuthContext` — never from client-supplied input (§3, §10, §26).
 */

function withRuleParams(ruleId: string) {
  return { params: Promise.resolve({ ruleId }) };
}
function withCodeParams(code: string) {
  return { params: Promise.resolve({ code }) };
}

const perVisitConfig = { pointsPerVisit: 10 };

describe("createPointRule — RBAC + server-derived merchantId (§9, §11)", () => {
  it("Staff (no MERCHANT_SETTINGS_MANAGE) is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await expect(
      createPointRule(staff.ctx, { name: "เข้าร้าน", type: "PER_VISIT", config: perVisitConfig }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("Manager and Owner (both hold MERCHANT_SETTINGS_MANAGE) can create a rule", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    const ownerRuleId = await createPointRule(ownerCtx, { name: "Owner rule", type: "PER_VISIT", config: perVisitConfig });
    const managerRuleId = await createPointRule(manager.ctx, { name: "Manager rule", type: "PER_VISIT", config: perVisitConfig });

    const rules = await listPointRules(ownerCtx);
    expect(rules.map((r) => r.id)).toEqual(expect.arrayContaining([ownerRuleId, managerRuleId]));
    // `CreatePointRuleInput` has no `merchantId` field at all — every created rule is stamped with
    // `ctx.merchantId` structurally, not merely by convention (§3, §10).
    expect(rules.every((r) => r.merchantId === merchantId)).toBe(true);
  });
});

describe("setPointRuleEnabled — RBAC + tenant isolation (the specific gap the Final Review blocked on)", () => {
  it("Staff (no MERCHANT_SETTINGS_MANAGE) is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const ruleId = await createPointRule(ownerCtx, { name: "เข้าร้าน", type: "PER_VISIT", config: perVisitConfig });

    await expect(setPointRuleEnabled(staff.ctx, ruleId, false)).rejects.toThrow(AuthorizationError);
  });

  it("Manager and Owner of the SAME merchant can toggle a rule", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const ruleId = await createPointRule(ownerCtx, { name: "เข้าร้าน", type: "PER_VISIT", config: perVisitConfig });

    await setPointRuleEnabled(manager.ctx, ruleId, false);
    expect((await listPointRules(ownerCtx)).find((r) => r.id === ruleId)?.enabled).toBe(false);

    await setPointRuleEnabled(ownerCtx, ruleId, true);
    expect((await listPointRules(ownerCtx)).find((r) => r.id === ruleId)?.enabled).toBe(true);
  });

  it("BLOCKER FIX: an Owner/Manager of a DIFFERENT merchant cannot enable/disable another merchant's rule (TenantIsolationError), and the rule is left completely untouched", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const managerB = await addStaffFixture(merchantB.ownerCtx, "MANAGER");
    const ruleId = await createPointRule(merchantA.ownerCtx, {
      name: "A's rule",
      type: "PER_VISIT",
      config: perVisitConfig,
    });

    await expect(setPointRuleEnabled(merchantB.ownerCtx, ruleId, false)).rejects.toThrow(
      TenantIsolationError,
    );
    await expect(setPointRuleEnabled(managerB.ctx, ruleId, false)).rejects.toThrow(TenantIsolationError);

    // Cross-tenant attempts (from Owner AND Manager) must never have taken effect.
    const rulesA = await listPointRules(merchantA.ownerCtx);
    expect(rulesA.find((r) => r.id === ruleId)?.enabled).toBe(true);
  });

  it("a non-existent ruleId is rejected without leaking anything about other merchants", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(setPointRuleEnabled(ownerCtx, "does-not-exist", false)).rejects.toThrow();
  });
});

describe("listPointRules — every role can read; tenant isolation always applies (§9, §11)", () => {
  it("Owner, Manager, AND Staff can all list — POINTS_VIEW_HISTORY is held by every role in the LOCKED matrix (no unauthorized-role case exists for this read)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await createPointRule(ownerCtx, { name: "เข้าร้าน", type: "PER_VISIT", config: perVisitConfig });

    await expect(listPointRules(ownerCtx)).resolves.toHaveLength(1);
    await expect(listPointRules(manager.ctx)).resolves.toHaveLength(1);
    await expect(listPointRules(staff.ctx)).resolves.toHaveLength(1);
  });

  it("never returns another merchant's rules", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    await createPointRule(merchantA.ownerCtx, { name: "A rule", type: "PER_VISIT", config: perVisitConfig });
    await createPointRule(merchantB.ownerCtx, { name: "B rule", type: "PER_VISIT", config: perVisitConfig });

    const rulesA = await listPointRules(merchantA.ownerCtx);
    expect(rulesA).toHaveLength(1);
    expect(rulesA[0].merchantId).toBe(merchantA.merchantId);
  });
});

describe("searchMemberships — Staff Search, RBAC + tenant isolation (§33)", () => {
  it("Owner, Manager, AND Staff can all search — MEMBER_SEARCH is held by every role in the LOCKED matrix (no unauthorized-role case exists for this read)", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await createMembership(ownerCtx, { displayName: "Somchai Search" });

    await expect(searchMemberships(ownerCtx, "Somchai")).resolves.toHaveLength(1);
    await expect(searchMemberships(manager.ctx, "Somchai")).resolves.toHaveLength(1);
    await expect(searchMemberships(staff.ctx, "Somchai")).resolves.toHaveLength(1);
  });

  it("never returns another merchant's members, even for an identical name prefix (tenant isolation, not just a display filter)", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    await createMembership(merchantA.ownerCtx, { displayName: "Malee Cross" });
    await createMembership(merchantB.ownerCtx, { displayName: "Malee Cross" });

    const resultsB = await searchMemberships(merchantB.ownerCtx, "Malee");
    expect(resultsB).toHaveLength(1);
    expect(resultsB[0].merchantId).toBe(merchantB.merchantId);
  });

  it("an empty/whitespace query returns [] without ever querying Firestore", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(searchMemberships(ownerCtx, "   ")).resolves.toEqual([]);
  });
});

describe("getMembershipByCode — QR Scan flow, RBAC + IDOR defense (§33)", () => {
  it("Owner, Manager, AND Staff can all look up by code", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const membershipId = await createMembership(ownerCtx, { displayName: "Codey" });
    const { memberCode } = await getMembership(ownerCtx, membershipId);

    await expect(getMembershipByCode(ownerCtx, memberCode)).resolves.toMatchObject({ id: membershipId });
    await expect(getMembershipByCode(manager.ctx, memberCode)).resolves.toMatchObject({ id: membershipId });
    await expect(getMembershipByCode(staff.ctx, memberCode)).resolves.toMatchObject({ id: membershipId });
  });

  it("BLOCKER FIX / IDOR: a code belonging to another merchant returns NotFoundError — never TenantIsolationError, never the membership itself (must not confirm cross-tenant existence)", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const membershipIdA = await createMembership(merchantA.ownerCtx, { displayName: "Secret A" });
    const { memberCode } = await getMembership(merchantA.ownerCtx, membershipIdA);

    let caught: unknown;
    try {
      await getMembershipByCode(merchantB.ownerCtx, memberCode);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    expect(caught).not.toBeInstanceOf(TenantIsolationError);

    // Merchant A's own owner can still resolve it normally.
    await expect(getMembershipByCode(merchantA.ownerCtx, memberCode)).resolves.toMatchObject({
      id: membershipIdA,
    });
  });

  it("an unknown code (no membership at all) also returns NotFoundError — indistinguishable from the cross-tenant case", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(getMembershipByCode(ownerCtx, "NOPE1234")).rejects.toThrow(NotFoundError);
  });
});

// --- API/HTTP boundary ------------------------------------------------------------------------
// Everything above proves the service layer (the actual authorization boundary, §10) is correct.
// The tests below prove the Route Handlers wire into that same boundary correctly end to end —
// unauthenticated rejection, RBAC-at-the-boundary, and cross-tenant target handling — using REAL
// exported Route Handlers + real emulator-issued ID Tokens, same pattern as
// `api-auth-transport.test.ts`/`api-staff-management.test.ts` from Phase 1–2.

describe("API boundary — unauthenticated access is rejected (§8)", () => {
  it("GET /api/points-rules", async () => {
    const res = await getPointsRules(jsonRequest("http://localhost/api/points-rules"));
    expect(res.status).toBe(401);
  });

  it("POST /api/points-rules", async () => {
    const res = await postPointsRules(
      jsonRequest("http://localhost/api/points-rules", {
        method: "POST",
        json: { name: "x", type: "PER_VISIT", config: perVisitConfig },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("PATCH /api/points-rules/[ruleId]/enabled", async () => {
    const res = await patchPointsRuleEnabled(
      jsonRequest("http://localhost/api/points-rules/x/enabled", { method: "PATCH", json: { enabled: true } }),
      withRuleParams("x"),
    );
    expect(res.status).toBe(401);
  });

  it("GET /api/members/search", async () => {
    const res = await getMembersSearch(jsonRequest("http://localhost/api/members/search?q=x"));
    expect(res.status).toBe(401);
  });

  it("GET /api/members/by-code/[code]", async () => {
    const res = await getMemberByCode(
      jsonRequest("http://localhost/api/members/by-code/ABC"),
      withCodeParams("ABC"),
    );
    expect(res.status).toBe(401);
  });
});

describe("API boundary — RBAC and cross-tenant IDOR enforced end to end through the real Route Handlers", () => {
  it("POST /api/points-rules: Staff gets 403, Manager gets 201", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const body = { name: "เข้าร้าน", type: "PER_VISIT", config: perVisitConfig };

    const asStaff = await postPointsRules(
      jsonRequest("http://localhost/api/points-rules", {
        method: "POST",
        token: await idTokenFor(staff.authUid),
        json: body,
      }),
    );
    expect(asStaff.status).toBe(403);

    const asManager = await postPointsRules(
      jsonRequest("http://localhost/api/points-rules", {
        method: "POST",
        token: await idTokenFor(manager.authUid),
        json: body,
      }),
    );
    expect(asManager.status).toBe(201);
  });

  it("POST /api/points-rules ignores a forged merchantId in the body — the rule is always created under the caller's own verified merchant", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");

    const res = await postPointsRules(
      jsonRequest("http://localhost/api/points-rules", {
        method: "POST",
        token: await idTokenFor(merchantA.ownerAuthUid),
        // merchantId is in the body, but the route never reads it — it's always ctx.merchantId.
        json: { name: "forged", type: "PER_VISIT", config: perVisitConfig, merchantId: merchantB.merchantId },
      }),
    );
    expect(res.status).toBe(201);

    const rulesA = await listPointRules(merchantA.ownerCtx);
    expect(rulesA.some((r) => r.name === "forged")).toBe(true);
    const rulesB = await listPointRules(merchantB.ownerCtx);
    expect(rulesB.some((r) => r.name === "forged")).toBe(false);
  });

  it("PATCH /api/points-rules/[ruleId]/enabled: cross-tenant ruleId is denied (403), not silently ignored", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const ruleId = await createPointRule(merchantA.ownerCtx, {
      name: "A rule",
      type: "PER_VISIT",
      config: perVisitConfig,
    });

    const res = await patchPointsRuleEnabled(
      jsonRequest(`http://localhost/api/points-rules/${ruleId}/enabled`, {
        method: "PATCH",
        token: await idTokenFor(merchantB.ownerAuthUid),
        json: { enabled: false },
      }),
      withRuleParams(ruleId),
    );
    expect(res.status).toBe(403);

    const rulesA = await listPointRules(merchantA.ownerCtx);
    expect(rulesA.find((r) => r.id === ruleId)?.enabled).toBe(true);
  });

  it("GET /api/members/by-code/[code]: cross-tenant code returns 404, never the other merchant's member data", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    const membershipIdA = await createMembership(merchantA.ownerCtx, { displayName: "Secret A" });
    const { memberCode } = await getMembership(merchantA.ownerCtx, membershipIdA);

    const res = await getMemberByCode(
      jsonRequest(`http://localhost/api/members/by-code/${memberCode}`, {
        token: await idTokenFor(merchantB.ownerAuthUid),
      }),
      withCodeParams(memberCode),
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/members/search: results are always scoped to the caller's own verified merchant (there is no merchantId query param to forge)", async () => {
    const merchantA = await createMerchantFixture("Merchant A");
    const merchantB = await createMerchantFixture("Merchant B");
    await createMembership(merchantA.ownerCtx, { displayName: "Zeta Cross" });
    await createMembership(merchantB.ownerCtx, { displayName: "Zeta Cross" });

    const res = await getMembersSearch(
      jsonRequest("http://localhost/api/members/search?q=Zeta", {
        token: await idTokenFor(merchantB.ownerAuthUid),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ merchantId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0].merchantId).toBe(merchantB.merchantId);
  });
});
