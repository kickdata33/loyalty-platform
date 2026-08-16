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
 * Extended as each phase adds collections — currently covers Phase 1–5.
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
  // Phase 3 — Points (§5, §11, §12, §15, §27)
  pointRules: "pointRules",
  pointsLedger: "pointsLedger",
  pointsLots: "pointsLots",
  pointsLotConsumptions: "pointsLotConsumptions",
  idempotencyKeys: "idempotencyKeys",
  visits: "visits",
  events: "events",
  // Phase 4 — Rewards (§5, §13)
  rewardTemplates: "rewardTemplates",
  voucherInstances: "voucherInstances",
  // Phase 5 — Coupons (§5, §14)
  couponTemplates: "couponTemplates",
  couponInstances: "couponInstances",
} as const;

/** Sub-collection path helper: `merchants/{merchantId}/branches`. */
export function branchesCollection(merchantId: string) {
  return getDb().collection(COLLECTIONS.merchants).doc(merchantId).collection("branches");
}
