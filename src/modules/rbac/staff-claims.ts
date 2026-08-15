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
 * - Suspended (`status: 'SUSPENDED'`) or deleted → claims cleared entirely. A staff/owner with no
 *   `merchantId`/`role` claim fails closed at `buildAuthContext` (§8/§10) — they simply can no
 *   longer act as staff of any merchant, even if their Firebase Auth account still exists.
 *
 * Custom claims are cached client-side until the ID token is refreshed (§8) — callers that need
 * an immediate effect (e.g. a test asserting on the very next request) must force a token
 * refresh, this function only updates the server-side record Firebase Auth hands out on refresh.
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

  // Deleted, or suspended: revoke all custom claims for this Auth user.
  await auth.setCustomUserClaims(target.authUid, null);
}
