import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import type {
  Entitlement,
  EntitlementResourceType,
  PackageFeatures,
  PackageRecord,
  SubscriptionOverrides,
  SubscriptionRecord,
  SubscriptionStatus,
} from "@/modules/billing-entitlement/types";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";
import { branchesCollection, COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext, SuperAdminAuthContext } from "@/modules/shared/types";

/**
 * Subscription/Entitlement (FINAL-ARCHITECTURE.md §25, §37.3).
 *
 * `subscriptions/{merchantId}` is the single source of truth for subscription state; `merchants`
 * documents never carry a duplicate `packageId`/`subscriptionStatus`/`trialEndsAt` field (§25,
 * enforced simply by never writing those fields onto a merchant document anywhere in this repo).
 * Package CRUD and manual subscription changes are Phase 9 (Super Admin only, §25 "V1 ไม่มี
 * Automatic Subscription Billing") — everything below them was Phase 1 foundation.
 */

const DEFAULT_TRIAL_PERIOD_DAYS = 14;

/** Conservative defaults used while a merchant is on trial with no package assigned yet —
 * deliberately mirrors the Starter tier numbers in §25 so a self-service signup is immediately
 * usable without contacting Support (§0). */
const TRIAL_DEFAULT_ENTITLEMENT: Entitlement = {
  memberLimit: 500,
  staffLimit: 3,
  branchLimit: 1,
  features: { automation: false, advancedReports: false, segments: false },
};

/** Called once, as part of merchant creation (`createMerchantWithOwner`) — not exposed as a
 * general-purpose "change subscription" function; see `setMerchantSubscription` below for the
 * Phase 9 Super Admin path that handles every subsequent status/package/trial change. */
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

/** Pure merge logic: `merge(package.features/limits, subscription.overrides)` (§25) — the ONE
 * place this formula is implemented; both the plain-read and transaction-read variants below call
 * this instead of duplicating it (CLAUDE.md "ห้ามมี logic ซ้ำสองที่"). */
function mergeEntitlement(
  sub: SubscriptionRecord | undefined,
  pkg: PackageRecord | undefined,
): Entitlement {
  if (!sub || !sub.packageId || !pkg) {
    return {
      ...TRIAL_DEFAULT_ENTITLEMENT,
      features: { ...TRIAL_DEFAULT_ENTITLEMENT.features },
      ...(sub?.overrides ?? {}),
    };
  }
  return {
    memberLimit: sub.overrides?.memberLimit ?? pkg.memberLimit,
    staffLimit: sub.overrides?.staffLimit ?? pkg.staffLimit,
    branchLimit: sub.overrides?.branchLimit ?? pkg.branchLimit,
    features: pkg.features,
  };
}

/**
 * Resolves the effective entitlement for a merchant, computed live on every call — never cached
 * as state (§25).
 *
 * Takes an `AuthContext` and enforces the same tenant-isolation check as every other read in this
 * codebase — subscription/entitlement details are merchant-confidential (plan, limits), not
 * public data.
 */
export async function resolveEntitlement(ctx: AuthContext, merchantId: string): Promise<Entitlement> {
  // Any active staff of the merchant may read its own plan/limits (matches firestore.rules:
  // subscriptions/{merchantId} is readable by any role of that merchant, writable by none).
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, merchantId);
  const db = getDb();
  const subSnap = await db.collection(COLLECTIONS.subscriptions).doc(merchantId).get();
  const sub = subSnap.data() as SubscriptionRecord | undefined;
  if (!sub || !sub.packageId) return mergeEntitlement(sub, undefined);
  const pkgSnap = await db.collection(COLLECTIONS.packages).doc(sub.packageId).get();
  return mergeEntitlement(sub, pkgSnap.data() as PackageRecord | undefined);
}

/** Transaction-scoped variant of `resolveEntitlement`, with NO permission check (the caller
 * already authorized the write this entitlement check is gating) — used exclusively by
 * `enforceEntitlementLimitTx` below (§37.3: "เช็คนี้ต้องอยู่ภายใน Firestore transaction เดียวกับ write
 * ที่สร้าง resource ใหม่"). */
async function resolveEntitlementTx(tx: Transaction, merchantId: string): Promise<Entitlement> {
  const db = getDb();
  const subSnap = await tx.get(db.collection(COLLECTIONS.subscriptions).doc(merchantId));
  const sub = subSnap.data() as SubscriptionRecord | undefined;
  if (!sub || !sub.packageId) return mergeEntitlement(sub, undefined);
  const pkgSnap = await tx.get(db.collection(COLLECTIONS.packages).doc(sub.packageId));
  return mergeEntitlement(sub, pkgSnap.data() as PackageRecord | undefined);
}

const RESOURCE_LABEL: Record<EntitlementResourceType, string> = {
  member: "members",
  staff: "staff",
  branch: "branches",
};

/** Builds the (unexecuted) count query for a resource type, always scoped by a server-derived
 * `merchantId` — never client input (§3, §10, §37.3). `staff` counts only `staffUsers` created via
 * `createStaffUser` (role MANAGER/STAFF) — the Owner, created via `createMerchantWithOwner` on a
 * separate bootstrap path before any package exists, does not count against `staffLimit` (§37.3). */
function countQueryFor(resourceType: EntitlementResourceType, merchantId: string) {
  const db = getDb();
  switch (resourceType) {
    case "member":
      return db.collection(COLLECTIONS.memberships).where("merchantId", "==", merchantId);
    case "staff":
      return db
        .collection(COLLECTIONS.staffUsers)
        .where("merchantId", "==", merchantId)
        .where("role", "in", ["MANAGER", "STAFF"]);
    case "branch":
      return branchesCollection(merchantId);
  }
}

/**
 * Entitlement Limit Enforcement (§37.3, Phase 9 Blocker 3, Locked — Option A). Must be called
 * INSIDE the same Firestore transaction as the write that creates the new resource, as the first
 * read of that transaction's own reads (before any write in the transaction) — never
 * check-then-write. Throws `ValidationError` (aborting the whole transaction, no partial write) if
 * the merchant is already at its hard limit; a `null` limit means unlimited and is never blocked.
 *
 * No denormalized counter field is introduced anywhere — this is a live `count()` aggregate query,
 * scoped by `merchantId`, run as `tx.get()` so it participates in the transaction's own
 * conflict detection (two concurrent creates racing the same limit cannot both succeed).
 */
export async function enforceEntitlementLimitTx(
  tx: Transaction,
  merchantId: string,
  resourceType: EntitlementResourceType,
): Promise<void> {
  const entitlement = await resolveEntitlementTx(tx, merchantId);
  const limit =
    resourceType === "member"
      ? entitlement.memberLimit
      : resourceType === "staff"
        ? entitlement.staffLimit
        : entitlement.branchLimit;
  if (limit === null) return; // unlimited

  const countSnap = await tx.get(countQueryFor(resourceType, merchantId).count());
  const current = countSnap.data().count;
  if (current >= limit) {
    throw new ValidationError(
      `This merchant has reached its ${RESOURCE_LABEL[resourceType]} limit (${limit}). Upgrade the package to add more.`,
    );
  }
}

// --- Super Admin — Package management (§25, §37.3; Phase 9) ------------------------------------

export interface UpsertPackageInput {
  name: string;
  memberLimit: number;
  staffLimit: number;
  branchLimit: number;
  features: PackageFeatures;
  price: number;
}

function assertValidPackageInput(input: UpsertPackageInput): void {
  if (input.name.trim().length === 0) throw new ValidationError("name must not be empty.");
  for (const [key, value] of [
    ["memberLimit", input.memberLimit],
    ["staffLimit", input.staffLimit],
    ["branchLimit", input.branchLimit],
    ["price", input.price],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new ValidationError(`${key} must be a non-negative number.`);
    }
  }
}

/** `packages/{packageId}` — managed by Super Admin only (§25). Read is public to any signed-in
 * user via `firestore.rules` already (needed for plan comparison UI) — only writes need a server
 * route/service function. */
/** Same "server is the only path" reasoning as `listMerchantsForSuperAdmin` (§37,
 * `merchant/service.ts`) — `packages` is directly client-readable per `firestore.rules` already,
 * this exists so `/superadmin/*` stays consistent with the rest of the app's data-access pattern.
 * Takes no `SuperAdminAuthContext` — gated entirely by the caller (every `/api/superadmin/*`
 * route calls `requireSuperAdminAuthContext` first). */
export async function listPackages(): Promise<PackageRecord[]> {
  const snap = await getDb().collection(COLLECTIONS.packages).get();
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PackageRecord, "id">) }));
}

export async function createPackage(admin: SuperAdminAuthContext, input: UpsertPackageInput): Promise<string> {
  assertValidPackageInput(input);
  const ref = getDb().collection(COLLECTIONS.packages).doc();
  await ref.set({
    name: input.name,
    memberLimit: input.memberLimit,
    staffLimit: input.staffLimit,
    branchLimit: input.branchLimit,
    features: input.features,
    price: input.price,
  } satisfies Omit<PackageRecord, "id">);
  await writeAuditLog({
    merchantId: "platform", // not merchant-scoped — a platform-wide config change
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: "package.created",
    targetType: "package",
    targetId: ref.id,
    after: input,
  });
  return ref.id;
}

export async function updatePackage(
  admin: SuperAdminAuthContext,
  packageId: string,
  input: UpsertPackageInput,
): Promise<void> {
  assertValidPackageInput(input);
  const ref = getDb().collection(COLLECTIONS.packages).doc(packageId);
  const snap = await ref.get();
  if (!snap.exists) throw new NotFoundError(`Package ${packageId} not found.`);
  const before = snap.data() as Omit<PackageRecord, "id">;
  await ref.update({
    name: input.name,
    memberLimit: input.memberLimit,
    staffLimit: input.staffLimit,
    branchLimit: input.branchLimit,
    features: input.features,
    price: input.price,
  });
  await writeAuditLog({
    merchantId: "platform", // not merchant-scoped — a platform-wide config change
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: "package.updated",
    targetType: "package",
    targetId: packageId,
    before,
    after: input,
  });
}

// --- Super Admin — Manual subscription changes (§25 "Billing", §37; Phase 9) -------------------

export interface SetMerchantSubscriptionInput {
  packageId?: string | null;
  status?: SubscriptionStatus;
  trialEndsAt?: Timestamp | null;
  currentPeriodEnd?: Timestamp | null;
  overrides?: SubscriptionOverrides;
  reason: string;
}

/** §25: "Super Admin กำหนด Package/Trial/Start/Expiry/Paid/Past Due/Suspended เองผ่าน manual
 * action" — V1 has no automatic billing, so this IS the entire subscription-change surface.
 * Appends to `subscriptions.history[]` (already part of the locked §25 schema) rather than
 * introducing a parallel audit mechanism for this specific change type. */
export async function setMerchantSubscription(
  admin: SuperAdminAuthContext,
  merchantId: string,
  input: SetMerchantSubscriptionInput,
): Promise<void> {
  if (input.reason.trim().length === 0) {
    throw new ValidationError("reason is required to change a merchant's subscription.");
  }
  const ref = getDb().collection(COLLECTIONS.subscriptions).doc(merchantId);
  const snap = await ref.get();
  if (!snap.exists) throw new NotFoundError(`Subscription for merchant ${merchantId} not found.`);
  const before = snap.data() as SubscriptionRecord;

  const nextStatus = input.status ?? before.status;
  const historyEntry: SubscriptionRecord["history"][number] = {
    from: before.status,
    to: nextStatus,
    changedBy: admin.authUid,
    changedAt: Timestamp.now(),
    reason: input.reason,
  };

  await ref.update({
    ...(input.packageId !== undefined ? { packageId: input.packageId } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt } : {}),
    ...(input.currentPeriodEnd !== undefined ? { currentPeriodEnd: input.currentPeriodEnd } : {}),
    ...(input.overrides !== undefined ? { overrides: input.overrides } : {}),
    history: FieldValue.arrayUnion(historyEntry),
  });

  await writeAuditLog({
    merchantId,
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: "subscription.updated",
    targetType: "subscription",
    targetId: merchantId,
    before: { packageId: before.packageId, status: before.status },
    after: { packageId: input.packageId ?? before.packageId, status: nextStatus },
    reason: input.reason,
  });
}
