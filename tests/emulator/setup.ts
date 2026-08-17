import { randomUUID } from "node:crypto";

import { getAdminAuth } from "@/lib/firebase/admin";
import { createMerchantWithOwner } from "@/modules/merchant/service";
import { syncStaffCustomClaims } from "@/modules/rbac/staff-claims";
import { getDb } from "@/modules/shared/firestore";
import type { AuthContext, SuperAdminAuthContext } from "@/modules/shared/types";
import { createStaffUser } from "@/modules/staff/service";

import { getIdTokenForExistingUid } from "./client-auth";

/**
 * Shared helpers for tests that run against the Firebase emulators (Auth + Firestore), started
 * via `npm run test:emulator` (`firebase emulators:exec`, which sets `FIRESTORE_EMULATOR_HOST` /
 * `FIREBASE_AUTH_EMULATOR_HOST` for us — `getDb()`/`getAdminAuth()` pick those up automatically,
 * see `src/lib/firebase/admin.ts`).
 *
 * Every test generates its own randomized ids (merchant slugs, emails, ...) instead of relying on
 * a global "clear all emulator data" reset between tests. This keeps tests safe to run in any
 * order/concurrency without needing to coordinate a shared wipe — important because
 * `tests/security-rules/*` uses `@firebase/rules-unit-testing` against the same emulator (with
 * `singleProjectMode` in `firebase.json`, all project ids resolve to the same underlying data).
 */

export function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@example.test`;
}

/** Creates a real Firebase Auth emulator user and returns its uid — used for staff/owner fixtures
 * so `syncStaffCustomClaims` has a real Auth user to attach custom claims to. */
export async function createTestAuthUser(emailPrefix: string): Promise<string> {
  const user = await getAdminAuth().createUser({ email: uniqueEmail(emailPrefix) });
  return user.uid;
}

export interface MerchantFixture {
  merchantId: string;
  branchId: string;
  ownerStaffUserId: string;
  ownerAuthUid: string;
  ownerCtx: AuthContext;
}

/**
 * Creates a real Merchant + default Branch + Owner (real Auth user, StaffUser doc, and synced
 * custom claims) end to end through the actual service layer — the same path a real signup would
 * take, minus the Cloud Functions trigger itself (claims are synced by directly calling the same
 * `syncStaffCustomClaims` function the trigger delegates to; see staff-claims.test.ts).
 */
export async function createMerchantFixture(namePrefix = "Test Merchant"): Promise<MerchantFixture> {
  const ownerAuthUid = await createTestAuthUser("owner");
  const { merchantId, branchId, staffUserId } = await createMerchantWithOwner({
    name: namePrefix,
    slug: uniqueSlug("merchant"),
    businessType: "cafe",
    timezone: "Asia/Bangkok",
    ownerAuthUid,
  });

  await syncStaffCustomClaims(getAdminAuth(), {
    staffUserId,
    before: null,
    after: { merchantId, authUid: ownerAuthUid, role: "OWNER", status: "ACTIVE", branchScope: [] },
  });

  const ownerCtx: AuthContext = {
    authUid: ownerAuthUid,
    merchantId,
    role: "OWNER",
    staffUserId,
    branchScope: [],
  };

  return { merchantId, branchId, ownerStaffUserId: staffUserId, ownerAuthUid, ownerCtx };
}

export interface StaffFixture {
  authUid: string;
  staffUserId: string;
  ctx: AuthContext;
}

/** Adds a Manager/Staff to an existing merchant fixture, through the real service layer, with
 * custom claims synced the same way `createMerchantFixture` handles the Owner. */
export async function addStaffFixture(
  ownerCtx: AuthContext,
  role: "MANAGER" | "STAFF",
): Promise<StaffFixture> {
  const authUid = await createTestAuthUser(role.toLowerCase());
  const staffUserId = await createStaffUser(ownerCtx, { authUid, role });
  await syncStaffCustomClaims(getAdminAuth(), {
    staffUserId,
    before: null,
    after: { merchantId: ownerCtx.merchantId, authUid, role, status: "ACTIVE", branchScope: [] },
  });
  const ctx: AuthContext = {
    authUid,
    merchantId: ownerCtx.merchantId,
    role,
    staffUserId,
    branchScope: [],
  };
  return { authUid, staffUserId, ctx };
}

/** Real, verifiable ID Token for a fixture's `authUid` — for tests that call API Route Handlers
 * directly and need a token `getAdminAuth().verifyIdToken()` will actually accept (see
 * `./client-auth.ts`). */
export async function idTokenFor(authUid: string): Promise<string> {
  return getIdTokenForExistingUid(authUid);
}

export interface SuperAdminFixture {
  authUid: string;
  ctx: SuperAdminAuthContext;
}

/** Creates a real Firebase Auth emulator user with `{ superAdmin: true }` custom claim (§6, §37)
 * — set out-of-band the same way it would be in production (`setCustomUserClaims` directly, never
 * via `onStaffUserWrite`, which never touches this claim). */
export async function createSuperAdminFixture(): Promise<SuperAdminFixture> {
  const authUid = await createTestAuthUser("superadmin");
  await getAdminAuth().setCustomUserClaims(authUid, { superAdmin: true });
  return { authUid, ctx: { authUid } };
}

/** Builds a `Request` with a JSON body and/or a Bearer token — shared by every API route test. */
export function jsonRequest(
  url: string,
  init: (Omit<RequestInit, "body"> & { token?: string; json?: unknown }) = {},
): Request {
  const { token, json, headers, ...rest } = init;
  return new Request(url, {
    ...rest,
    headers: {
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : undefined,
  });
}

export { getAdminAuth, getDb };
