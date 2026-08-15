import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { getFirebaseAdminApp } from "@/lib/firebase/admin";

/**
 * Firestore client wrapper for server-side module code (FINAL-ARCHITECTURE.md §31:
 * `/modules/shared` owns "the Firestore client wrapper"). Every domain module reads/writes
 * Firestore through `getDb()` — never instantiates its own client — so tests can rely on a single
 * consistent connection (emulator-aware via `src/lib/firebase/admin.ts`).
 */

let cachedDb: Firestore | undefined;

export function getDb(): Firestore {
  if (cachedDb) return cachedDb;
  cachedDb = getFirestore(getFirebaseAdminApp());
  return cachedDb;
}

/**
 * Canonical Firestore collection names (FINAL-ARCHITECTURE.md §5). Centralized here so a typo in
 * a collection name is a compile error (via `COLLECTIONS.foo`) instead of a silent runtime bug.
 * Only collections implemented in Phase 1 are listed — extend as later phases add collections.
 */
export const COLLECTIONS = {
  platformCustomers: "platformCustomers",
  customerIdentities: "customerIdentities",
  merchants: "merchants",
  staffUsers: "staffUsers",
  memberships: "memberships",
  auditLogs: "auditLogs",
  subscriptions: "subscriptions",
  packages: "packages",
} as const;

/** Sub-collection path helper: `merchants/{merchantId}/branches`. */
export function branchesCollection(merchantId: string) {
  return getDb().collection(COLLECTIONS.merchants).doc(merchantId).collection("branches");
}
