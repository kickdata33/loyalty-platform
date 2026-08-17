import "server-only";

import { verifyBearerToken } from "@/lib/api/auth";
import { AuthenticationError } from "@/modules/shared/errors";
import type { SuperAdminAuthContext } from "@/modules/shared/types";

/**
 * Server-side identity resolution for Super Admin (`/superadmin`) API routes
 * (FINAL-ARCHITECTURE.md §37, §6, §26).
 *
 * Deliberately separate from `requireStaffAuthContext` (`./auth.ts`) — a Super Admin has no
 * `merchantId`/`role`/`staffUserId` custom claim, so building an `AuthContext` from a Super
 * Admin's token would either fail closed for the wrong reason or (worse) require loosening
 * `buildAuthContext`'s validation in a way that could accidentally accept a malformed/partial
 * Staff/Owner token too. This function never touches `AuthContext`/`buildAuthContext` at all —
 * every Super Admin API route calls this instead, and merchant-scoped work (if any) always goes
 * through an explicit, audited `supportSessions/{sessionId}` (`@/modules/support-session/service`).
 *
 * Reuses `verifyBearerToken` (the same Firebase ID Token verification `requireStaffAuthContext`
 * uses) so there is exactly one place in the codebase that parses the `Authorization` header and
 * calls `verifyIdToken` — only the claim being asserted afterward differs.
 */
export async function requireSuperAdminAuthContext(request: Request): Promise<SuperAdminAuthContext> {
  const decoded = await verifyBearerToken(request);
  if (decoded.superAdmin !== true) {
    throw new AuthenticationError("This action requires Super Admin access.");
  }
  return { authUid: decoded.uid };
}
