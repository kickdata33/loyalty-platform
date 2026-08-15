import type { Auth } from "firebase-admin/auth";

import type { Role, StaffStatus } from "@/modules/shared/types";

/**
 * The ONE mechanism that sets Firebase Auth custom claims for staff/owner users
 * (FINAL-ARCHITECTURE.md §8, §10, §32: "ทาง**เดียว**ที่ตั้งได้").
 *
 * This module is intentionally framework-agnostic (no Next.js import, no `@/lib/firebase/admin`
 * import) and takes its `Auth` instance and the before/after StaffUser snapshots as plain
 * parameters (§31: "modules ที่ไม่ผูก UI framework ใช้ร่วมกันได้ทั้ง Next.js และ Cloud
 * Functions"). It is called from exactly one place in production: the `onStaffUserWrite`
 * Firestore trigger in `functions/src/index.ts`, which passes it the trigger's own
 * before/after document snapshots. No other code path may set these claims — Firestore Security
 * Rules deny all client writes to `staffUsers` (see `firestore.rules`), and no other server
 * function calls `auth.setCustomUserClaims` directly.
 */

export interface StaffUserClaimsSnapshot {
  merchantId: string;
  authUid: string;
  role: Role;
  status: StaffStatus;
  /** Empty/undefined = unrestricted (all branches), per §11. */
  branchScope?: string[];
}

export interface SyncStaffCustomClaimsParams {
  staffUserId: string;
  /** Document data before the write. `null` if the document did not previously exist. */
  before: StaffUserClaimsSnapshot | null;
  /** Document data after the write. `null` if the document was deleted. */
  after: StaffUserClaimsSnapshot | null;
}

/**
 * Syncs a staff/owner's Firebase Auth custom claims to match the current `staffUsers` document.
 *
 * - Created or updated with `status: 'ACTIVE'` → claims set to
 *   `{ merchantId, role, staffUserId, branchScope }`.
 * - Suspended (`status: 'SUSPENDED'`) or deleted → claims cleared AND all of the user's refresh
 *   tokens are revoked (`auth.revokeRefreshTokens`). Clearing claims alone is not enough: a
 *   suspended staff member's *already-issued* ID Token stays cryptographically valid — with the
 *   old claims still baked in — for up to its natural ~1 hour expiry, because Firebase only
 *   re-evaluates custom claims when a token is next minted (§8's documented client-side claims
 *   cache applies here too, just server-side). Revoking refresh tokens sets the account's
 *   `tokensValidAfterTime`, which `verifyIdToken(token, /* checkRevoked *\/ true)` in
 *   `src/lib/api/auth.ts` checks on every request — so a suspended/removed staff member loses API
 *   access immediately, not after up to an hour. Found during the Phase 2 security review;
 *   role/branchScope changes that keep `status: 'ACTIVE'` do NOT revoke — only actual access
 *   removal does, matching §8's existing "force refresh after a role change" guidance rather than
 *   forcing a full re-login for a routine promotion/demotion.
 */
export async function syncStaffCustomClaims(
  auth: Auth,
  { staffUserId, before, after }: SyncStaffCustomClaimsParams,
): Promise<void> {
  const target = after ?? before;
  if (!target) return; // Nothing to do — no snapshot to identify which Auth user to touch.

  if (after && after.status === "ACTIVE") {
    await auth.setCustomUserClaims(target.authUid, {
      merchantId: after.merchantId,
      role: after.role,
      staffUserId,
      branchScope: after.branchScope ?? [],
    });
    return;
  }

  // Deleted, or suspended: revoke all custom claims AND all currently-valid sessions.
  await auth.setCustomUserClaims(target.authUid, null);
  await auth.revokeRefreshTokens(target.authUid);
}
