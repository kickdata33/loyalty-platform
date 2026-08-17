import type { Timestamp } from "firebase-admin/firestore";

/**
 * `supportSessions/{sessionId}` — FINAL-ARCHITECTURE.md §37.1 (Phase 9 Blocker 1, Locked —
 * Option A). Server-write only, deny-all client access (same tier as `platformCustomers`/
 * `customerIdentities`, §6).
 *
 * This is the ONLY mechanism by which a Super Admin (who holds no `merchantId`/`role` claim,
 * §6/§10) is granted access to a specific merchant's data — never via custom claims, never via a
 * client-supplied `merchantId`.
 */
export interface SupportSessionRecord {
  id: string;
  superAdminUid: string;
  merchantId: string;
  reason: string;
  grantedAt: Timestamp;
  expiresAt: Timestamp;
  revokedAt: Timestamp | null;
  revokedBy: string | null;
}

/** Read-only "View-as" snapshot of a merchant's operational data — §37.1: V1 scope is read-only,
 * Support Session never writes/mutates business state on the Owner's behalf. Deliberately limited
 * to collections that are otherwise 100% deny-all to everyone (including Super Admin's own direct
 * client reads) — merchant/staff/subscription basics are already directly readable by
 * `isSuperAdmin()` via `firestore.rules` and don't need a session at all. */
export interface SupportSnapshot {
  merchantId: string;
  merchant: { name: string; slug: string; businessType: string } | null;
  subscription: { packageId: string | null; status: string } | null;
  staffCount: number;
  membershipCount: number;
  recentPointsLedger: Array<{
    id: string;
    membershipId: string;
    type: string;
    delta: number;
    reason: string;
    createdAt: Timestamp | null;
  }>;
  automations: Array<{ id: string; name: string; status: string; presentedAs: string }>;
  recentNotificationLog: Array<{
    id: string;
    templateType: string;
    status: string;
    error: string | null;
    createdAt: Timestamp | null;
  }>;
}
