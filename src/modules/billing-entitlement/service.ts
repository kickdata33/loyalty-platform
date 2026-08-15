import { Timestamp } from "firebase-admin/firestore";

import type { Entitlement, PackageRecord, SubscriptionRecord } from "@/modules/billing-entitlement/types";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Subscription/Entitlement foundation (FINAL-ARCHITECTURE.md §25) — Phase 1 scope only.
 *
 * `subscriptions/{merchantId}` is the single source of truth for subscription state; `merchants`
 * documents never carry a duplicate `packageId`/`subscriptionStatus`/`trialEndsAt` field (§25,
 * enforced simply by never writing those fields onto a merchant document anywhere in this repo).
 * Package CRUD, billing UI, and real package seed data are Phase 9 (Super Admin) — Phase 1 only
 * needs new merchants to end up with a valid subscription record and a working entitlement read.
 */

const DEFAULT_TRIAL_PERIOD_DAYS = 14;

/** Conservative defaults used while a merchant is on trial with no package assigned yet (no
 * `packages` seed data exists before Phase 9) — deliberately mirrors the Starter tier numbers in
 * §25 so a self-service signup is immediately usable without contacting Support (§0). */
const TRIAL_DEFAULT_ENTITLEMENT: Entitlement = {
  memberLimit: 500,
  staffLimit: 3,
  branchLimit: 1,
  features: { automation: false, advancedReports: false, segments: false },
};

/** Called once, as part of merchant creation (`createMerchantWithOwner`) — not exposed as a
 * general-purpose "change subscription" function; status transitions beyond initial TRIAL setup
 * are Phase 9 (manual Super Admin action, §25: "V1 ไม่มี Automatic Subscription Billing"). */
export async function createDefaultSubscription(merchantId: string, changedBy: string): Promise<void> {
  const now = Timestamp.now();
  const trialEndsAt = Timestamp.fromMillis(
    now.toMillis() + DEFAULT_TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
  const ref = getDb().collection(COLLECTIONS.subscriptions).doc(merchantId);
  // Note: FieldValue.serverTimestamp() is NOT supported inside array elements in Firestore (it
  // silently resolves to null there) — `history[].changedAt` must use a client-computed
  // Timestamp instead, unlike every other `createdAt`/`updatedAt` field in this codebase.
  const historyEntry: SubscriptionRecord["history"][number] = {
    from: null,
    to: "TRIAL",
    changedBy,
    changedAt: now,
    reason: "merchant.created",
  };
  await ref.set({
    packageId: null,
    status: "TRIAL",
    trialEndsAt,
    currentPeriodEnd: null,
    history: [historyEntry],
  } satisfies Omit<SubscriptionRecord, "merchantId">);
}

/**
 * Resolves the effective entitlement for a merchant: `merge(package.features/limits,
 * subscription.overrides)` (§25), computed live on every call — never cached as state.
 *
 * Takes an `AuthContext` and enforces the same tenant-isolation check as every other read in
 * this codebase — subscription/entitlement details are merchant-confidential (plan, limits), not
 * public data, even though nothing calls this function yet in Phase 1 (added defensively so a
 * later phase's API route can't accidentally expose it un-gated).
 */
export async function resolveEntitlement(ctx: AuthContext, merchantId: string): Promise<Entitlement> {
  // Any active staff of the merchant may read its own plan/limits (matches firestore.rules:
  // subscriptions/{merchantId} is readable by any role of that merchant, writable by none).
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, merchantId);
  const db = getDb();
  const subSnap = await db.collection(COLLECTIONS.subscriptions).doc(merchantId).get();
  const sub = subSnap.data() as SubscriptionRecord | undefined;

  if (!sub || !sub.packageId) {
    return {
      ...TRIAL_DEFAULT_ENTITLEMENT,
      features: { ...TRIAL_DEFAULT_ENTITLEMENT.features },
      ...(sub?.overrides ?? {}),
    };
  }

  const pkgSnap = await db.collection(COLLECTIONS.packages).doc(sub.packageId).get();
  const pkg = pkgSnap.data() as PackageRecord | undefined;
  if (!pkg) {
    return TRIAL_DEFAULT_ENTITLEMENT;
  }

  return {
    memberLimit: sub.overrides?.memberLimit ?? pkg.memberLimit,
    staffLimit: sub.overrides?.staffLimit ?? pkg.staffLimit,
    branchLimit: sub.overrides?.branchLimit ?? pkg.branchLimit,
    features: pkg.features,
  };
}
