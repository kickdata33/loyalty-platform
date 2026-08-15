import type { DecodedIdToken } from "firebase-admin/auth";

import { AuthenticationError } from "@/modules/shared/errors";
import type { AuthContext, Role } from "@/modules/shared/types";

const VALID_ROLES: readonly Role[] = ["OWNER", "MANAGER", "STAFF"];

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (VALID_ROLES as readonly string[]).includes(value);
}

/**
 * Builds a verified `AuthContext` from a decoded, signature-verified Firebase ID token.
 *
 * This is the ONLY place server code should construct an `AuthContext` from — always call it
 * with the result of `getAdminAuth().verifyIdToken(idToken)`, never with a raw client-supplied
 * object. `merchantId`/`role`/`staffUserId`/`branchScope` are custom claims that are set
 * exclusively by the `onStaffUserWrite` trigger (§8, §10, §32) — a decoded, verified token is
 * therefore trustworthy for these fields; nothing here ever reads them from a request body.
 *
 * Fails closed: throws `AuthenticationError` if any required claim is missing or malformed
 * instead of defaulting to a permissive value.
 */
export function buildAuthContext(decodedToken: DecodedIdToken): AuthContext {
  const { uid, merchantId, role, staffUserId, branchScope } = decodedToken;

  if (typeof merchantId !== "string" || merchantId.length === 0) {
    throw new AuthenticationError(
      "Decoded ID token is missing a valid merchantId custom claim.",
    );
  }
  if (!isRole(role)) {
    throw new AuthenticationError("Decoded ID token is missing a valid role custom claim.");
  }
  if (typeof staffUserId !== "string" || staffUserId.length === 0) {
    throw new AuthenticationError(
      "Decoded ID token is missing a valid staffUserId custom claim.",
    );
  }
  if (branchScope !== undefined && !Array.isArray(branchScope)) {
    throw new AuthenticationError("Decoded ID token has a malformed branchScope custom claim.");
  }

  return {
    authUid: uid,
    merchantId,
    role,
    staffUserId,
    branchScope: Array.isArray(branchScope) ? (branchScope as string[]) : [],
  };
}
