import type { Timestamp } from "firebase-admin/firestore";

/** `subscriptions/{merchantId}` — FINAL-ARCHITECTURE.md §5, §25. Single Source of Truth. */
export type SubscriptionStatus =
  | "TRIAL"
  | "ACTIVE"
  | "PAST_DUE"
  | "GRACE"
  | "SUSPENDED"
  | "CANCELLED";

export interface SubscriptionOverrides {
  memberLimit?: number;
  staffLimit?: number;
  branchLimit?: number;
}

export interface SubscriptionHistoryEntry {
  from: SubscriptionStatus | null;
  to: SubscriptionStatus;
  changedBy: string;
  changedAt: Timestamp;
  reason?: string;
}

export interface SubscriptionRecord {
  merchantId: string;
  packageId: string | null;
  status: SubscriptionStatus;
  trialEndsAt: Timestamp | null;
  currentPeriodEnd: Timestamp | null;
  overrides?: SubscriptionOverrides;
  history: SubscriptionHistoryEntry[];
}

/** `packages/{packageId}` — managed by Super Admin only (Phase 9). Phase 1 defines the shape and
 * a `resolveEntitlement` reader only; no package CRUD or seed data ships in Phase 1. */
export interface PackageFeatures {
  automation: boolean;
  advancedReports: boolean;
  segments: boolean;
}

export interface PackageRecord {
  id: string;
  name: string;
  memberLimit: number;
  staffLimit: number;
  branchLimit: number;
  features: PackageFeatures;
  price: number;
}

export interface Entitlement {
  memberLimit: number | null;
  staffLimit: number | null;
  branchLimit: number | null;
  features: Partial<PackageFeatures>;
}

/** §37.3 (Phase 9, Locked) — the three "create new" resource types a package hard limit gates.
 * Deliberately a closed union (not an open string) so a typo/unsupported resource type is a
 * compile error, not a silently-unenforced limit. */
export type EntitlementResourceType = "member" | "staff" | "branch";
