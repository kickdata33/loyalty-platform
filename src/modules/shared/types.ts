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
