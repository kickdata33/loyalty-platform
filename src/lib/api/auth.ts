import "server-only";

import type { DecodedIdToken } from "firebase-admin/auth";

import { getAdminAuth } from "@/lib/firebase/admin";
import { assertMerchantStaffNotSuspended } from "@/modules/emergency-control/service";
import { buildAuthContext } from "@/modules/shared/auth-context";
import { AuthenticationError } from "@/modules/shared/errors";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Server-side ID Token verification for Staff/Owner API routes — implements the locked
 * Phase 2 Architecture Decision (FINAL-ARCHITECTURE.md §8, "Staff/Owner API Authentication
 * Transport"):
 *
 *   Authorization: Bearer <Firebase ID Token> → Firebase Admin verifyIdToken() → verified uid
 *   → resolve StaffUser server-side → AuthContext → Authorization Service (RBAC + tenant
 *   isolation)
 *
 * This is the ONLY place an API route should extract/verify a caller's identity. Every protected
 * route handler calls `requireStaffAuthContext()` before doing anything else — never trusts
 * `uid`/`role`/`permissions`/`merchantId` from the request body/query/headers.
 */

/**
 * Verifies the `Authorization: Bearer <token>` header and returns the decoded, verified token.
 *
 * `checkRevoked: true` additionally rejects a token whose account has been disabled or whose
 * refresh tokens have been revoked since the token was issued — not just a check of the JWT's own
 * expiry, matching the "expired/revoked token ต้องถูก reject" requirement.
 *
 * Used directly (without `buildAuthContext`) only by the one bootstrap route that creates a brand
 * new merchant for a just-signed-up user who has no StaffUser/custom claims yet
 * (`POST /api/merchants` — mirrors `createMerchantWithOwner`'s documented exception in
 * `src/modules/merchant/service.ts`). Every other protected route uses
 * `requireStaffAuthContext()` instead.
 */
export async function verifyBearerToken(request: Request): Promise<DecodedIdToken> {
  const header = request.headers.get("authorization");
  if (!header) {
    throw new AuthenticationError("Missing Authorization header.");
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const idToken = match?.[1]?.trim();
  if (!idToken) {
    throw new AuthenticationError(
      "Malformed Authorization header — expected 'Bearer <Firebase ID Token>'.",
    );
  }

  try {
    return await getAdminAuth().verifyIdToken(idToken, /* checkRevoked */ true);
  } catch {
    // Deliberately don't distinguish "expired" from "malformed" from "revoked" in the error
    // message returned to the client — the caller only needs to know it must re-authenticate.
    throw new AuthenticationError("Invalid, expired, or revoked ID Token.");
  }
}

/**
 * Verifies the Bearer token AND resolves it to a full `AuthContext` via the caller's own
 * `merchantId`/`role`/`staffUserId`/`branchScope` custom claims (set exclusively by the
 * `onStaffUserWrite` trigger — §8, §10). Fails closed (`AuthenticationError`) if the signed-in
 * user has no StaffUser claims at all (e.g. signed up but not yet added to any merchant, or
 * suspended and had their claims revoked).
 *
 * This is what every protected Staff/Owner API route should call first, before touching
 * `request.json()`/`request.url` for anything else.
 */
export async function requireStaffAuthContext(request: Request): Promise<AuthContext> {
  const decoded = await verifyBearerToken(request);
  const ctx = buildAuthContext(decoded);
  // Emergency Control (§37.2): a Super-Admin-wide "Suspend Staff" kill-switch for this merchant.
  // Single choke point for every protected Staff/Owner route (§10 "ห้ามใส่ permission check
  // กระจาย") — Customer Portal never calls this function, so it is never affected.
  await assertMerchantStaffNotSuspended(ctx.merchantId);
  return ctx;
}
