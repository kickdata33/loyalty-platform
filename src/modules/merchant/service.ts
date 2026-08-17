import { FieldValue } from "firebase-admin/firestore";

import { createDefaultSubscription, enforceEntitlementLimitTx } from "@/modules/billing-entitlement/service";
import { writeAuditLog } from "@/modules/audit/service";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type {
  BrandingConfig,
  BranchRecord,
  BroadcastLimits,
  MerchantRecord,
  PointsExpirationPolicy,
  ReportSettings,
  SegmentRulesConfig,
  StaffLimits,
} from "@/modules/merchant/types";
import { ConflictError, NotFoundError, ValidationError } from "@/modules/shared/errors";
import { branchesCollection, COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";
import type { StaffUserRecord } from "@/modules/staff/types";
import type { SubscriptionRecord } from "@/modules/billing-entitlement/types";

/**
 * Merchant/Branch foundation (FINAL-ARCHITECTURE.md §4, §5). Onboarding UX (wizard, branding
 * template picker) is Phase 2 — this module only provides the underlying service functions Phase
 * 2's API routes will call, plus what Phase 1's own tests need to set up fixtures.
 */

// `managerApprovalThreshold` must stay below `manualAdjustmentLimit` for the two-tier check in
// `assertWithinStaffLimits` (src/modules/points/ledger-service.ts, §9) to mean anything for the
// STAFF role: manualAdjustmentLimit is the hard ceiling nobody (Staff included) may exceed via
// manual add, while managerApprovalThreshold is the lower bar above which a Staff-role manual add
// is rejected outright (ask a Manager/Owner to do it instead) — reversed, the lower limit would
// always throw first and the approval-threshold check would be unreachable dead config.
const DEFAULT_STAFF_LIMITS: StaffLimits = {
  maxPointsPerTransaction: 1000,
  maxPointsPerHour: 5000,
  maxPointsPerDay: 20000,
  manualAdjustmentLimit: 2000,
  managerApprovalThreshold: 500,
};

const DEFAULT_POINTS_EXPIRATION_POLICY: PointsExpirationPolicy = { type: "NEVER" };

const DEFAULT_SEGMENT_RULES: SegmentRulesConfig = {
  inactiveAfterDays: 60,
  atRiskAfterDays: 30,
  regularMinVisits30d: 3,
};

/** §24 "Report Settings Schema Location" (Phase 8, Locked) — off by default; Owner opts in via
 * `updateReportSettings` (report/service.ts). No delivery-channel field — Dashboard-only in V1. */
const DEFAULT_REPORT_SETTINGS: ReportSettings = {
  dailyEnabled: false,
  weeklyEnabled: false,
  monthlyEnabled: false,
  dailyItems: [],
  weeklyItems: [],
  monthlyItems: [],
};

/** §26 "Broadcast spam / message flooding", §38.1 (Phase 10, Locked) — an implementation
 * default, not a specified business rule (same category as `DEFAULT_STAFF_LIMITS`). */
const DEFAULT_BROADCAST_LIMITS: BroadcastLimits = {
  maxBroadcastsPerDay: 5,
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
      pointsExpirationPolicy: DEFAULT_POINTS_EXPIRATION_POLICY,
      reportSettings: DEFAULT_REPORT_SETTINGS,
      broadcastLimits: DEFAULT_BROADCAST_LIMITS,
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

/**
 * System-level read (no `AuthContext`/permission check) for server code that already runs in a
 * trusted context and isn't acting on behalf of a specific staff request — the same category as
 * `dailyAutomationBatch`/`dispatchEventToAutomations` (Phase 6). Kept separate from `getMerchant`
 * below (which enforces `MEMBER_VIEW` and is what every staff-facing call site should use
 * instead) rather than making callers pass a fabricated `AuthContext` just to satisfy a check that
 * doesn't apply to them.
 */
export async function getMerchantRecordOrThrow(merchantId: string): Promise<MerchantRecord> {
  const snap = await getDb().collection(COLLECTIONS.merchants).doc(merchantId).get();
  if (!snap.exists) throw new NotFoundError(`Merchant ${merchantId} not found.`);
  return { id: snap.id, ...(snap.data() as Omit<MerchantRecord, "id">) };
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
  // Entitlement Limit Enforcement (§37.3, Locked) — wrapped in a transaction (this write was
  // previously a plain `.set()`) so the count-then-create is atomic, same as member/staff.
  await getDb().runTransaction(async (tx) => {
    await enforceEntitlementLimitTx(tx, input.merchantId, "branch");
    tx.create(ref, { name: input.name, address: input.address, isActive: true });
  });

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

const HTTP_URL_PATTERN = /^https?:\/\//i;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

/**
 * Updates a merchant's branding config (§33 Phase 2: "Branding config + template"). Owner and
 * Manager both hold `BRANDING_MANAGE` (§9) — Staff does not.
 *
 * Validates URL scheme/color format server-side (found during the Phase 2 security review):
 * `logoUrl`/`coverUrl` are rendered as an `<img src>` in the Customer Portal — without this check
 * an Owner account (malicious or compromised) could set a `javascript:`/`data:` value. Low
 * severity given the render context (an `<img src>`, not `dangerouslySetInnerHTML`) and that it
 * only affects that merchant's own storefront, but cheap to close outright.
 */
export async function updateMerchantBranding(
  ctx: AuthContext,
  merchantId: string,
  branding: BrandingConfig,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.BRANDING_MANAGE, merchantId);

  if (branding.logoUrl !== undefined && !HTTP_URL_PATTERN.test(branding.logoUrl)) {
    throw new ValidationError("logoUrl must be an http(s) URL.");
  }
  if (branding.coverUrl !== undefined && !HTTP_URL_PATTERN.test(branding.coverUrl)) {
    throw new ValidationError("coverUrl must be an http(s) URL.");
  }
  if (branding.primaryColor !== undefined && !HEX_COLOR_PATTERN.test(branding.primaryColor)) {
    throw new ValidationError("primaryColor must be a hex color, e.g. #0f172a.");
  }

  const ref = getDb().collection(COLLECTIONS.merchants).doc(merchantId);
  const snap = await ref.get();
  if (!snap.exists) throw new NotFoundError(`Merchant ${merchantId} not found.`);
  const before = (snap.data() as MerchantRecord).branding;

  await ref.update({ branding });

  await writeAuditLog({
    merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "merchant.branding_updated",
    targetType: "merchant",
    targetId: merchantId,
    before,
    after: branding,
  });
}

/**
 * The one deliberately-public read in this module — used by the Customer Portal skeleton
 * (`/m/[merchantSlug]`, §2, §33) to render a merchant's storefront branding before any customer
 * identity exists (real customer auth is Phase 7). Takes no `AuthContext` on purpose: this is not
 * a staff-authorization boundary, it's the same "public storefront" concept every merchant's
 * platform already exposes by having a public slug/URL at all.
 *
 * Returns ONLY `name`/`slug`/`branding` — never `staffLimits`, `ownerUserId`,
 * `segmentRulesConfig`, or anything else on the merchant document that isn't meant to be public.
 */
export interface PublicMerchantProfile {
  merchantId: string;
  name: string;
  slug: string;
  branding: BrandingConfig;
  /** Phase 7 (§22) — the merchant's LIFF App ID, needed client-side to initialize
   * `LiffClientProvider`. Not a secret (LIFF IDs are meant to be embedded in a public URL/page by
   * design) — `null` until the merchant has connected LINE (§19/§20). */
  liffId: string | null;
}

export async function getPublicMerchantProfileBySlug(
  slug: string,
): Promise<PublicMerchantProfile | null> {
  const snap = await getDb()
    .collection(COLLECTIONS.merchants)
    .where("slug", "==", slug)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data() as MerchantRecord;
  const lineConfigSnap = await getDb().collection(COLLECTIONS.lineChannelConfigs).doc(doc.id).get();
  const liffId = lineConfigSnap.exists ? (lineConfigSnap.data() as { loginChannel: { liffId: string | null } }).loginChannel.liffId : null;
  return { merchantId: doc.id, name: data.name, slug: data.slug, branding: data.branding, liffId };
}

// --- Super Admin reads (§37; Phase 9 — Merchant list/detail) -----------------------------------
//
// `firestore.rules` already permits `isSuperAdmin()` to read `merchants`/`staffUsers`/
// `subscriptions` directly via the client SDK (§3, present since Phase 1) — these server-side
// equivalents exist instead so `/superadmin/*` follows the SAME "server is the only path" pattern
// every other page in this codebase already uses (no page anywhere calls the client Firestore SDK
// directly for reads; see `src/lib/api/client.ts`), rather than introducing a second, inconsistent
// data-access pattern just for this one section of the app.

export interface SuperAdminMerchantSummary {
  id: string;
  name: string;
  slug: string;
  businessType: string;
  subscriptionStatus: string | null;
}

/** Takes no `SuperAdminAuthContext` — like `getMerchantRecordOrThrow` above, this is a
 * system-level read gated entirely by the caller (every `/api/superadmin/*` route calls
 * `requireSuperAdminAuthContext` first) rather than by any per-call scoping this function itself
 * would need `admin` for. */
export async function listMerchantsForSuperAdmin(): Promise<SuperAdminMerchantSummary[]> {
  const db = getDb();
  const merchantsSnap = await db.collection(COLLECTIONS.merchants).get();
  return Promise.all(
    merchantsSnap.docs.map(async (doc) => {
      const data = doc.data() as Omit<MerchantRecord, "id">;
      const subSnap = await db.collection(COLLECTIONS.subscriptions).doc(doc.id).get();
      const status = subSnap.exists ? (subSnap.data() as SubscriptionRecord).status : null;
      return { id: doc.id, name: data.name, slug: data.slug, businessType: data.businessType, subscriptionStatus: status };
    }),
  );
}

export interface SuperAdminMerchantDetail {
  merchant: MerchantRecord;
  subscription: SubscriptionRecord | null;
  staff: StaffUserRecord[];
}

export async function getMerchantDetailForSuperAdmin(merchantId: string): Promise<SuperAdminMerchantDetail> {
  const merchant = await getMerchantRecordOrThrow(merchantId);
  const db = getDb();
  const [subSnap, staffSnap] = await Promise.all([
    db.collection(COLLECTIONS.subscriptions).doc(merchantId).get(),
    db.collection(COLLECTIONS.staffUsers).where("merchantId", "==", merchantId).get(),
  ]);
  return {
    merchant,
    subscription: subSnap.exists ? ({ merchantId, ...(subSnap.data() as Omit<SubscriptionRecord, "merchantId">) }) : null,
    staff: staffSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<StaffUserRecord, "id">) })),
  };
}
