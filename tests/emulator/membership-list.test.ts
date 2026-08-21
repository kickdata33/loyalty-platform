import { beforeEach, describe, expect, it } from "vitest";

import { GET as searchMembersRoute } from "@/app/api/members/search/route";
import {
  createMembership,
  getMembership,
  listMemberships,
  resolveOrCreateLineMembership,
  searchMemberships,
} from "@/modules/membership/service";
import { InMemorySecretStore, setSecretStoreForTesting } from "@/modules/shared/secret-store";

import { addStaffFixture, createMerchantFixture, idTokenFor, jsonRequest, uniqueId } from "./setup";

/**
 * Regression coverage for two combined fixes:
 * 1. `/dashboard/members` default list + pagination (previously: no way to see members without
 *    already knowing a name/phone/code — impractical for LINE-joined customers).
 * 2. `tenantScopedPrefixQuery()`'s exact-match-only bug (missing the Unicode upper bound) and the
 *    LINE cosmetic-displayName capture fix (`resolveOrCreateLineMembership`'s `displayName:
 *    string | null` — real name when available, generic placeholder only as a true fallback,
 *    never overwritten by a later transient failure, never used for identity).
 */
beforeEach(() => {
  setSecretStoreForTesting(new InMemorySecretStore());
});

describe("listMemberships() — default member list", () => {
  it("returns only the authenticated merchant's members, newest first", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");

    await createMembership(merchantA.ownerCtx, { displayName: "First Joined" });
    await createMembership(merchantA.ownerCtx, { displayName: "Second Joined" });
    await createMembership(merchantB.ownerCtx, { displayName: "Other Merchant Member" });

    const page = await listMemberships(merchantA.ownerCtx);

    expect(page.memberships.every((m) => m.merchantId === merchantA.merchantId)).toBe(true);
    expect(page.memberships.map((m) => m.merchantProfile.displayName)).toEqual([
      "Second Joined",
      "First Joined",
    ]);
  });

  it("paginates with server-side cursors — never loads the whole collection at once", async () => {
    const merchant = await createMerchantFixture();
    for (let i = 0; i < 5; i++) {
      await createMembership(merchant.ownerCtx, { displayName: `Member ${i}` });
    }

    const firstPage = await listMemberships(merchant.ownerCtx, { pageSize: 3 });
    expect(firstPage.memberships).toHaveLength(3);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listMemberships(merchant.ownerCtx, {
      pageSize: 3,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.memberships).toHaveLength(2);
    expect(secondPage.nextCursor).toBeNull(); // last page

    const allIds = [...firstPage.memberships, ...secondPage.memberships].map((m) => m.id);
    expect(new Set(allIds).size).toBe(5); // no duplicates/overlap across pages
  });
});

describe("searchMemberships() — exact and partial matches (prefix-query fix)", () => {
  it("matches an exact full displayName", async () => {
    const merchant = await createMerchantFixture();
    await createMembership(merchant.ownerCtx, { displayName: "Somchai Prefix Test" });
    const results = await searchMemberships(merchant.ownerCtx, "Somchai Prefix Test");
    expect(results.map((m) => m.merchantProfile.displayName)).toContain("Somchai Prefix Test");
  });

  it("matches a genuine partial prefix of displayName (regression: was exact-match-only before the fix)", async () => {
    const merchant = await createMerchantFixture();
    await createMembership(merchant.ownerCtx, { displayName: "Somchai Prefix Test" });
    const results = await searchMemberships(merchant.ownerCtx, "Som");
    expect(results.map((m) => m.merchantProfile.displayName)).toContain("Somchai Prefix Test");
  });

  it("matches exact and partial phone number", async () => {
    const merchant = await createMerchantFixture();
    await createMembership(merchant.ownerCtx, { displayName: "Has Phone", phone: "0812345678" });
    const exact = await searchMemberships(merchant.ownerCtx, "0812345678");
    const partial = await searchMemberships(merchant.ownerCtx, "08123");
    expect(exact.map((m) => m.merchantProfile.displayName)).toContain("Has Phone");
    expect(partial.map((m) => m.merchantProfile.displayName)).toContain("Has Phone");
  });

  it("matches exact and partial member code (case-insensitive)", async () => {
    const merchant = await createMerchantFixture();
    const id = await createMembership(merchant.ownerCtx, { displayName: "Coded Member" });
    const created = await getMembership(merchant.ownerCtx, id);

    const exact = await searchMemberships(merchant.ownerCtx, created.memberCode);
    const partial = await searchMemberships(merchant.ownerCtx, created.memberCode.slice(0, 4).toLowerCase());

    expect(exact.map((m) => m.id)).toContain(id);
    expect(partial.map((m) => m.id)).toContain(id);
  });

  it("an empty/whitespace query returns [] from the service itself — the route is what redirects to the full list", async () => {
    const merchant = await createMerchantFixture();
    expect(await searchMemberships(merchant.ownerCtx, "")).toEqual([]);
    expect(await searchMemberships(merchant.ownerCtx, "   ")).toEqual([]);
  });
});

describe("GET /api/members/search — route: empty q lists all, non-empty q searches", () => {
  it("empty q returns the default list, not an empty array", async () => {
    const merchant = await createMerchantFixture();
    await createMembership(merchant.ownerCtx, { displayName: "Listed Member" });
    const token = await idTokenFor(merchant.ownerAuthUid);

    const res = await searchMembersRoute(jsonRequest("http://localhost/api/members/search?q=", { token }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberships: Array<{ displayName: string }> };
    expect(body.memberships.some((m) => m.displayName === "Listed Member")).toBe(true);
  });

  it("non-empty q searches and returns matches", async () => {
    const merchant = await createMerchantFixture();
    await createMembership(merchant.ownerCtx, { displayName: "Searchable Name" });
    const token = await idTokenFor(merchant.ownerAuthUid);

    const res = await searchMembersRoute(
      jsonRequest(`http://localhost/api/members/search?q=${encodeURIComponent("Searchable")}`, { token }),
    );
    const body = (await res.json()) as { memberships: Array<{ displayName: string }> };
    expect(body.memberships.some((m) => m.displayName === "Searchable Name")).toBe(true);
  });

  it("never exposes a LINE user id or platform customer id in the response", async () => {
    const merchant = await createMerchantFixture();
    await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId: uniqueId("pc"),
      lineUserId: uniqueId("Uline"),
      channelId: uniqueId("channel"),
      displayName: "LINE Member",
    });
    const token = await idTokenFor(merchant.ownerAuthUid);

    const res = await searchMembersRoute(jsonRequest("http://localhost/api/members/search?q=", { token }));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("lineUserId");
    expect(raw).not.toContain("platformCustomerId");
    expect(raw).not.toContain("merchantLineIdentity");
  });

  it("rejects an unauthenticated request", async () => {
    const res = await searchMembersRoute(jsonRequest("http://localhost/api/members/search?q="));
    expect(res.status).toBe(401);
  });

  it("Owner, Manager, and Staff can all view/search members (locked Permission Matrix V1)", async () => {
    const merchant = await createMerchantFixture();
    const manager = await addStaffFixture(merchant.ownerCtx, "MANAGER");
    const staff = await addStaffFixture(merchant.ownerCtx, "STAFF");

    for (const authUid of [merchant.ownerAuthUid, manager.authUid, staff.authUid]) {
      const token = await idTokenFor(authUid);
      const res = await searchMembersRoute(jsonRequest("http://localhost/api/members/search?q=", { token }));
      expect(res.status).toBe(200);
    }
  });

  it("tenant isolation: another merchant's Owner never sees this merchant's members via this route", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    await createMembership(merchantA.ownerCtx, { displayName: "Only In A" });

    const tokenB = await idTokenFor(merchantB.ownerAuthUid);
    const res = await searchMembersRoute(jsonRequest("http://localhost/api/members/search?q=", { token: tokenB }));
    const body = (await res.json()) as { memberships: Array<{ displayName: string }> };
    expect(body.memberships.some((m) => m.displayName === "Only In A")).toBe(false);
  });
});

describe("resolveOrCreateLineMembership() — cosmetic displayName, never identity", () => {
  it("a new LINE membership receives the real cosmetic displayName when provided", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId: uniqueId("pc"),
      lineUserId: uniqueId("Uline"),
      channelId: "channel-1",
      displayName: "Real LINE Name",
    });
    const membership = await getMembership(merchant.ownerCtx, membershipId);
    expect(membership.merchantProfile.displayName).toBe("Real LINE Name");
  });

  it("falls back to the generic placeholder only when no cosmetic name is available on first login", async () => {
    const merchant = await createMerchantFixture();
    const membershipId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId: uniqueId("pc"),
      lineUserId: uniqueId("Uline"),
      channelId: "channel-1",
      displayName: null,
    });
    const membership = await getMembership(merchant.ownerCtx, membershipId);
    expect(membership.merchantProfile.displayName).toBe("สมาชิก");
  });

  it("an existing membership updates displayName from the fallback to the real name on re-login, without creating a duplicate", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    const lineUserId = uniqueId("Uline");

    const firstId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId,
      lineUserId,
      channelId: "channel-1",
      displayName: null,
    });
    expect((await getMembership(merchant.ownerCtx, firstId)).merchantProfile.displayName).toBe("สมาชิก");

    const secondId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId,
      lineUserId,
      channelId: "channel-1",
      displayName: "Now Available Name",
    });

    expect(secondId).toBe(firstId); // same membership, not a duplicate
    expect((await getMembership(merchant.ownerCtx, secondId)).merchantProfile.displayName).toBe(
      "Now Available Name",
    );
  });

  it("a transient missing displayName on re-login never reverts an already-captured real name", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    const lineUserId = uniqueId("Uline");

    const firstId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId,
      lineUserId,
      channelId: "channel-1",
      displayName: "Captured Real Name",
    });
    const secondId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId,
      lineUserId,
      channelId: "channel-1",
      displayName: null,
    });

    expect(secondId).toBe(firstId);
    expect((await getMembership(merchant.ownerCtx, secondId)).merchantProfile.displayName).toBe(
      "Captured Real Name",
    );
  });

  it("repeating the same LINE login always resolves the same membership — never creates a duplicate", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    const lineUserId = uniqueId("Uline");
    const base = { merchantId: merchant.merchantId, platformCustomerId, lineUserId, channelId: "channel-1" };

    const id1 = await resolveOrCreateLineMembership({ ...base, displayName: "Name A" });
    const id2 = await resolveOrCreateLineMembership({ ...base, displayName: "Name B" });
    const id3 = await resolveOrCreateLineMembership({ ...base, displayName: "Name C" });

    expect(id1).toBe(id2);
    expect(id2).toBe(id3);

    const page = await listMemberships(merchant.ownerCtx);
    expect(page.memberships.filter((m) => m.id === id1)).toHaveLength(1); // exactly one document total
  });

  it("identity resolution never depends on displayName — same platformCustomerId with a completely different name still resolves to the same membership (LINE profile data is never used for identity)", async () => {
    const merchant = await createMerchantFixture();
    const platformCustomerId = uniqueId("pc");
    const lineUserId = uniqueId("Uline");
    const base = { merchantId: merchant.merchantId, platformCustomerId, lineUserId, channelId: "channel-1" };

    const id1 = await resolveOrCreateLineMembership({ ...base, displayName: "Alice" });
    const id2 = await resolveOrCreateLineMembership({ ...base, displayName: "Completely Different Bob" });

    expect(id1).toBe(id2); // match key is (merchantId, platformCustomerId) only, never displayName
  });
});
