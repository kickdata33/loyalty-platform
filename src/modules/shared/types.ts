/**
 * Cross-module shared types. FINAL-ARCHITECTURE.md §31: `/modules/shared` — types shared across
 * bounded contexts, not owned by any single domain module.
 */

/** Permission Matrix V1 (LOCKED) — FINAL-ARCHITECTURE.md §9. Do not edit without new approval. */
export type Role = "OWNER" | "MANAGER" | "STAFF";

export type StaffStatus = "ACTIVE" | "SUSPENDED";

/**
 * The verified, server-derived identity of a Staff/Owner caller for a single merchant.
 *
 * Built exclusively from Firebase Auth custom claims (`buildAuthContext`, §8/§10) — never from
 * request payload fields. Every service function that performs a merchant-scoped operation takes
 * an `AuthContext` and derives `merchantId` from it, never from caller-supplied input.
 */
export interface AuthContext {
  /** Firebase Auth uid of the signed-in staff/owner. */
  authUid: string;
  merchantId: string;
  role: Role;
  staffUserId: string;
  /** Empty array = unrestricted (all branches). See FINAL-ARCHITECTURE.md §11. */
  branchScope: string[];
}

/** actorType values used across auditLogs/pointsLedger/etc. (§18). */
export type ActorType = "staff" | "superAdmin" | "system";

/**
 * The verified identity of a Super Admin caller (FINAL-ARCHITECTURE.md §37.1).
 *
 * Deliberately NOT `AuthContext` — a Super Admin has no `merchantId`/`role`/`staffUserId` claim
 * (§6: superAdmin is `{ superAdmin: true }` only, set out-of-band via script/console, never via
 * `onStaffUserWrite`). Keeping this a separate, narrower type means the Authorization Service's
 * `requirePermission`/`requireOwner` (which assume a real merchant-scoped Owner/Manager/Staff)
 * can never be accidentally satisfied by a Super Admin caller — Super Admin merchant access is
 * always mediated by an explicit, audited Support Session (`@/modules/support-session/service`),
 * never by widening what `AuthContext` accepts.
 */
export interface SuperAdminAuthContext {
  /** Firebase Auth uid of the signed-in Super Admin. */
  authUid: string;
}
