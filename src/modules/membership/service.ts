import { FieldValue, type Transaction } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { enforceEntitlementLimitTx } from "@/modules/billing-entitlement/service";
import { writeEvent } from "@/modules/event/service";
import { createPlatformCustomer } from "@/modules/identity/service";
import { requireBranchScope, requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { MembershipRecord } from "@/modules/membership/types";
import { NotFoundError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";
import { branchesCollection, COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Membership foundation (FINAL-ARCHITECTURE.md §4, §5, §7). Phase 1 only implements the
 * staff-created path (counter-created member, no LINE/phone identity yet — that arrives with
 * Phase 7). Staff search (by name/phone/member code) is explicitly a Phase 3 decision (§35 item
 * 2); this module only provides `getMembership`/`listMemberships` as the minimal foundation Phase
 * 1's own tests need.
 */

function generateMemberCode(membershipId: string): string {
  return membershipId.slice(0, 8).toUpperCase();
}

export interface CreateMembershipInput {
  displayName: string;
  phone?: string;
  email?: string;
  branchId?: string;
}

/**
 * Creates a member at the counter, with no external identity to verify (§7:
 * `profileSource: 'STAFF_INPUT'`). Always creates a brand-new PlatformCustomer — merging across
 * merchants only ever happens through the opt-in verified-phone/email flow (§6), never here.
 */
export async function createMembership(
  ctx: AuthContext,
  input: CreateMembershipInput,
): Promise<string> {
  requirePermission(ctx, PERMISSIONS.MEMBER_CREATE, ctx.merchantId);
  if (input.displayName.trim().length === 0) {
    throw new ValidationError("displayName must not be empty.");
  }
  if (input.branchId) {
    requireBranchScope(ctx, input.branchId);
    const branchSnap = await branchesCollection(ctx.merchantId).doc(input.branchId).get();
    if (!branchSnap.exists) {
      throw new ValidationError(`Branch ${input.branchId} does not exist for this merchant.`);
    }
  }

  const platformCustomerId = await createPlatformCustomer();

  const db = getDb();
  const ref = db.collection(COLLECTIONS.memberships).doc();
  // Wrapped in a (zero-read) transaction so `membership.created` — needed by Phase 6's
  // MEMBER_CREATED trigger / "Welcome" preset — is written atomically with the membership doc
  // itself (§17: "เขียนใน transaction เดียวกัน"), not as a separate best-effort call.
  await db.runTransaction(async (tx) => {
    // Entitlement Limit Enforcement (§37.3, Locked) — must run before any write in this
    // transaction (Firestore: all reads before all writes).
    await enforceEntitlementLimitTx(tx, ctx.merchantId, "member");

    tx.create(ref, {
      platformCustomerId,
      merchantId: ctx.merchantId,
      branchId: input.branchId ?? null,
      memberCode: generateMemberCode(ref.id),
      joinedAt: FieldValue.serverTimestamp(),
      merchantProfile: {
        displayName: input.displayName,
        phone: input.phone ?? null,
        email: input.email ?? null,
        consentMarketing: false,
        profileSource: "STAFF_INPUT",
      },
      merchantLineIdentity: null,
      pointsBalance: 0,
      pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
      tags: [],
      activityStats: {
        lastVisitAt: null,
        visitCount30d: 0,
        visitCount90d: 0,
        firstVisitAt: null,
        segment: "NEW",
      },
    });
    writeEvent(tx, {
      merchantId: ctx.merchantId,
      type: "membership.created",
      membershipId: ref.id,
      payload: { profileSource: "STAFF_INPUT" },
    });
  });

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "membership.created",
    targetType: "membership",
    targetId: ref.id,
    after: { displayName: input.displayName, profileSource: "STAFF_INPUT" },
  });

  return ref.id;
}

/**
 * Loads the membership document first, then authorizes against its *actual* `merchantId` (§10) —
 * this is what turns a forged/guessed cross-tenant `membershipId` into a `TenantIsolationError`
 * rather than accidentally returning another merchant's member data.
 */
export async function getMembership(
  ctx: AuthContext,
  membershipId: string,
): Promise<MembershipRecord> {
  const snap = await getDb().collection(COLLECTIONS.memberships).doc(membershipId).get();
  if (!snap.exists) throw new NotFoundError(`Membership ${membershipId} not found.`);
  const data = snap.data() as Omit<MembershipRecord, "id">;
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, data.merchantId);
  return { id: snap.id, ...data };
}

/**
 * Transaction-scoped membership load-then-authorize, for domain services that need to read a
 * membership as part of a larger atomic write (points earn/adjust/reverse, reward redeem/use, ...)
 * — `tx.get()` instead of a plain `.get()` so the read participates in the caller's transaction's
 * optimistic-concurrency check (§12). Throws `TenantIsolationError` (not a generic
 * `AuthorizationError`) on a cross-tenant `membershipId`, matching every other resource lookup in
 * this codebase (§10, §26) — tests assert on this specific type.
 *
 * Used to be a private copy inside `points/ledger-service.ts` (Phase 3); moved here and exported
 * in Phase 4 because `reward/service.ts` needs the exact same primitive and CLAUDE.md forbids
 * duplicating logic across modules ("ห้ามมี logic ซ้ำสองที่").
 */
export async function loadMembershipForMerchantTx(
  tx: Transaction,
  membershipId: string,
  merchantId: string,
): Promise<MembershipRecord> {
  const ref = getDb().collection(COLLECTIONS.memberships).doc(membershipId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new NotFoundError(`Membership ${membershipId} not found.`);
  const data = { id: snap.id, ...(snap.data() as Omit<MembershipRecord, "id">) };
  if (data.merchantId !== merchantId) {
    throw new TenantIsolationError(
      `Staff of merchant ${merchantId} attempted to access a membership of merchant ${data.merchantId}.`,
    );
  }
  return data;
}

export async function listMemberships(ctx: AuthContext): Promise<MembershipRecord[]> {
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.memberships)
    .where("merchantId", "==", ctx.merchantId)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<MembershipRecord, "id">) }));
}

/** `memberCode` is generated uppercase (see `generateMemberCode`) — normalizing lookup input the
 * same way lets Staff Scan/Search work regardless of how the code was typed/encoded. */
function normalizeMemberCode(code: string): string {
  return code.trim().toUpperCase();
}

const PREFIX_QUERY_LIMIT = 20;

/** `merchantId` equality is ALWAYS the first filter, combined with the field's startAt/endAt
 * range -- this needs a composite index (merchantId asc, <field> asc), see
 * firestore.indexes.json -- and, critically, means the result limit applies *within this
 * merchant's own data*, not globally across every merchant that happens to share a prefix. */
function tenantScopedPrefixQuery(merchantId: string, field: string, prefix: string) {
  return getDb()
    .collection(COLLECTIONS.memberships)
    .where("merchantId", "==", merchantId)
    .orderBy(field)
    .startAt(prefix)
    .endAt(`${prefix}`)
    .limit(PREFIX_QUERY_LIMIT);
}

/**
 * Staff Search (§33 Phase 3, §35 item 2 — Firestore prefix-query, the architecture's own
 * recommended V1 default; "พอสำหรับ 500-10,000 members/ร้าน"). Searches `displayName`, `phone`,
 * and `memberCode` prefixes, always filtered to the caller's own merchant, and merges/dedupes the
 * three result sets. Never touches `platformCustomers`/`customerIdentities` (§7).
 */
export async function searchMemberships(ctx: AuthContext, query: string): Promise<MembershipRecord[]> {
  requirePermission(ctx, PERMISSIONS.MEMBER_SEARCH, ctx.merchantId);
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const [byName, byPhone, byCode] = await Promise.all([
    tenantScopedPrefixQuery(ctx.merchantId, "merchantProfile.displayName", trimmed).get(),
    tenantScopedPrefixQuery(ctx.merchantId, "merchantProfile.phone", trimmed).get(),
    tenantScopedPrefixQuery(ctx.merchantId, "memberCode", normalizeMemberCode(trimmed)).get(),
  ]);

  const byId = new Map<string, MembershipRecord>();
  for (const snap of [byName, byPhone, byCode]) {
    for (const doc of snap.docs) {
      const data = doc.data() as Omit<MembershipRecord, "id">;
      byId.set(doc.id, { id: doc.id, ...data }); // merchantId already guaranteed by the query itself
    }
  }
  return [...byId.values()];
}

/**
 * Staff Scan flow: exact lookup by `memberCode` (what a member's QR encodes — see
 * `src/modules/points/qr.ts`). Loads then authorizes against the *actual* merchantId (§10), same
 * pattern as `getMembership` — a forged/foreign code correctly yields `NotFoundError`/
 * `TenantIsolationError`, never another merchant's member data.
 */
export async function getMembershipByCode(
  ctx: AuthContext,
  memberCode: string,
): Promise<MembershipRecord> {
  requirePermission(ctx, PERMISSIONS.MEMBER_SEARCH, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.memberships)
    .where("memberCode", "==", normalizeMemberCode(memberCode))
    .limit(1)
    .get();
  if (snap.empty) throw new NotFoundError(`No member found for code ${memberCode}.`);
  const doc = snap.docs[0];
  const data = doc.data() as Omit<MembershipRecord, "id">;
  if (data.merchantId !== ctx.merchantId) {
    throw new NotFoundError(`No member found for code ${memberCode}.`); // don't leak cross-tenant existence
  }
  return { id: doc.id, ...data };
}

export interface ResolveLineMembershipInput {
  merchantId: string;
  platformCustomerId: string;
  /** Verified `sub` from `verifyLineIdToken` ONLY — never a raw client-supplied value (§21). */
  lineUserId: string;
  channelId: string;
  /** From `liff.getProfile()` — display-only, low-stakes (a nickname), unlike `lineUserId` never
   * used for identity/security decisions. §21's "untrusted client input" concern is about identity
   * (who this is), not cosmetic display text, matching how `STAFF_INPUT` members' `displayName` is
   * already fully staff-typed and unverified. */
  displayName: string;
}

/**
 * Customer self-service registration/login (§20 "Customer-side" flow) — no `AuthContext`, no
 * staff actor, deliberately NOT gated by `PERMISSIONS.MEMBER_CREATE` (a Staff/Owner-only
 * permission that has no meaning here). `merchantId` must already be server-resolved (from a
 * verified `merchantSlug` lookup) by the caller — this function trusts its `merchantId` parameter
 * for that reason, unlike every staff-facing function in this file which derives it from
 * `AuthContext` instead; it never accepts it from raw request body input directly.
 *
 * Idempotent: a customer opening the same merchant's portal again resolves the SAME Membership
 * (queried by `platformCustomerId` — itself already resolved idempotently by
 * `resolveOrCreatePlatformCustomer`, §6) rather than creating a duplicate.
 */
export async function resolveOrCreateLineMembership(input: ResolveLineMembershipInput): Promise<string> {
  const db = getDb();
  const existingSnap = await db
    .collection(COLLECTIONS.memberships)
    .where("merchantId", "==", input.merchantId)
    .where("platformCustomerId", "==", input.platformCustomerId)
    .limit(1)
    .get();
  if (!existingSnap.empty) {
    const ref = existingSnap.docs[0].ref;
    // Keep `merchantLineIdentity` current (re-login refreshes linkedAt) — never touches points/
    // tags/activityStats, only the LINE-identity sub-object.
    await ref.update({
      merchantLineIdentity: {
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        linkedAt: FieldValue.serverTimestamp(),
        friendshipStatus: "UNKNOWN",
      },
    });
    return ref.id;
  }

  const ref = db.collection(COLLECTIONS.memberships).doc();
  await db.runTransaction(async (tx) => {
    tx.create(ref, {
      platformCustomerId: input.platformCustomerId,
      merchantId: input.merchantId,
      branchId: null,
      memberCode: generateMemberCode(ref.id),
      joinedAt: FieldValue.serverTimestamp(),
      merchantProfile: {
        displayName: input.displayName,
        phone: null,
        email: null,
        consentMarketing: false,
        profileSource: "LINE_PROFILE_AUTOFILL",
      },
      merchantLineIdentity: {
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        linkedAt: FieldValue.serverTimestamp(),
        friendshipStatus: "UNKNOWN",
      },
      pointsBalance: 0,
      pointsBalanceUpdatedAt: FieldValue.serverTimestamp(),
      tags: [],
      activityStats: { lastVisitAt: null, visitCount30d: 0, visitCount90d: 0, firstVisitAt: null, segment: "NEW" },
    });
    writeEvent(tx, {
      merchantId: input.merchantId,
      type: "membership.created",
      membershipId: ref.id,
      payload: { profileSource: "LINE_PROFILE_AUTOFILL" },
    });
  });
  return ref.id;
}
