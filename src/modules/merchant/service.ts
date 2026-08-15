import { FieldValue } from "firebase-admin/firestore";

import { createDefaultSubscription } from "@/modules/billing-entitlement/service";
import { writeAuditLog } from "@/modules/audit/service";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { BranchRecord, MerchantRecord, SegmentRulesConfig, StaffLimits } from "@/modules/merchant/types";
import { ConflictError, NotFoundError, ValidationError } from "@/modules/shared/errors";
import { branchesCollection, COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Merchant/Branch foundation (FINAL-ARCHITECTURE.md §4, §5). Onboarding UX (wizard, branding
 * template picker) is Phase 2 — this module only provides the underlying service functions Phase
 * 2's API routes will call, plus what Phase 1's own tests need to set up fixtures.
 */

const DEFAULT_STAFF_LIMITS: StaffLimits = {
  maxPointsPerTransaction: 1000,
  maxPointsPerHour: 5000,
  maxPointsPerDay: 20000,
  manualAdjustmentLimit: 500,
  managerApprovalThreshold: 2000,
};

const DEFAULT_SEGMENT_RULES: SegmentRulesConfig = {
  inactiveAfterDays: 60,
  atRiskAfterDays: 30,
  regularMinVisits30d: 3,
};

const SLUG_PATTERN = /^[a-z0-9-]{3,50}$/;
const DEFAULT_BRANCH_NAME = "สาขาหลัก";

export interface CreateMerchantInput {
  name: string;
  slug: string;
  businessType: string;
  timezone: string;
  ownerAuthUid: string;
  staffLimits?: Partial<StaffLimits>;
  segmentRulesConfig?: Partial<SegmentRulesConfig>;
}

export interface CreateMerchantResult {
  merchantId: string;
  branchId: string;
  staffUserId: string;
}

/**
 * Bootstrap-only entry point: creates a Merchant, its default Branch, its first StaffUser
 * (role='OWNER'), and its default Subscription (TRIAL) atomically. Deliberately takes no
 * `AuthContext` — at signup time no StaffUser/custom-claims exist yet for this person, so there
 * is nothing to authorize against. This is the one and only place in the codebase that creates a
 * StaffUser without going through an `AuthContext`-gated call.
 *
 * Slug uniqueness is enforced by reading the uniqueness-check query *inside* the transaction
 * (`tx.get(query)`) rather than as a separate pre-check — Firestore includes queries read inside
 * a transaction in its conflict detection, so two concurrent signups racing for the same slug
 * cannot both succeed (the loser's transaction is retried and its retry observes the winner's
 * document, then throws `ConflictError`).
 */
export async function createMerchantWithOwner(
  input: CreateMerchantInput,
): Promise<CreateMerchantResult> {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new ValidationError(
      "slug must be 3-50 characters of lowercase letters, digits, or hyphens.",
    );
  }
  if (input.name.trim().length === 0) {
    throw new ValidationError("name must not be empty.");
  }
  if (input.ownerAuthUid.trim().length === 0) {
    throw new ValidationError("ownerAuthUid must not be empty.");
  }

  const db = getDb();
  const merchantRef = db.collection(COLLECTIONS.merchants).doc();
  const branchRef = branchesCollection(merchantRef.id).doc();
  const staffRef = db.collection(COLLECTIONS.staffUsers).doc();

  await db.runTransaction(async (tx) => {
    const slugQuery = db
      .collection(COLLECTIONS.merchants)
      .where("slug", "==", input.slug)
      .limit(1);
    const existingSlug = await tx.get(slugQuery);
    if (!existingSlug.empty) {
      throw new ConflictError(`Merchant slug '${input.slug}' is already taken.`);
    }

    tx.create(merchantRef, {
      name: input.name,
      slug: input.slug,
      businessType: input.businessType,
      branding: {},
      timezone: input.timezone,
      staffLimits: { ...DEFAULT_STAFF_LIMITS, ...input.staffLimits },
      segmentRulesConfig: { ...DEFAULT_SEGMENT_RULES, ...input.segmentRulesConfig },
      ownerUserId: input.ownerAuthUid,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(branchRef, {
      name: DEFAULT_BRANCH_NAME,
      address: "",
      isActive: true,
    });
    tx.create(staffRef, {
      merchantId: merchantRef.id,
      authUid: input.ownerAuthUid,
      role: "OWNER",
      permissionOverrides: [],
      branchScope: [],
      status: "ACTIVE",
    });
  });

  await createDefaultSubscription(merchantRef.id, input.ownerAuthUid);

  await writeAuditLog({
    merchantId: merchantRef.id,
    actorType: "system",
    actorId: input.ownerAuthUid,
    action: "merchant.created",
    targetType: "merchant",
    targetId: merchantRef.id,
    after: { name: input.name, slug: input.slug },
  });

  return { merchantId: merchantRef.id, branchId: branchRef.id, staffUserId: staffRef.id };
}

/** Any active staff of the merchant can read their own merchant's basic settings. */
export async function getMerchant(
  ctx: AuthContext,
  merchantId: string,
): Promise<MerchantRecord> {
  // merchants/{merchantId} is keyed by merchantId itself, so — unlike a lookup by opaque doc id —
  // the tenant check can happen before ever touching Firestore for another tenant's document.
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, merchantId);
  const snap = await getDb().collection(COLLECTIONS.merchants).doc(merchantId).get();
  if (!snap.exists) throw new NotFoundError(`Merchant ${merchantId} not found.`);
  return { id: snap.id, ...(snap.data() as Omit<MerchantRecord, "id">) };
}

export interface CreateBranchInput {
  merchantId: string;
  name: string;
  address: string;
}

export async function createBranch(
  ctx: AuthContext,
  input: CreateBranchInput,
): Promise<string> {
  requirePermission(ctx, PERMISSIONS.MERCHANT_SETTINGS_MANAGE, input.merchantId);
  if (input.name.trim().length === 0) {
    throw new ValidationError("Branch name must not be empty.");
  }

  const ref = branchesCollection(input.merchantId).doc();
  await ref.set({ name: input.name, address: input.address, isActive: true });

  await writeAuditLog({
    merchantId: input.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "branch.created",
    targetType: "branch",
    targetId: ref.id,
    after: { name: input.name, address: input.address },
  });

  return ref.id;
}

export async function listBranches(
  ctx: AuthContext,
  merchantId: string,
): Promise<BranchRecord[]> {
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, merchantId);
  const snap = await branchesCollection(merchantId).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<BranchRecord, "id">) }));
}
