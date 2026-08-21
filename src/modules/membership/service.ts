import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";

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

export const MEMBER_LIST_DEFAULT_PAGE_SIZE = 20;
const MEMBER_LIST_MAX_PAGE_SIZE = 100;

export interface ListMembershipsOptions {
  pageSize?: number;
  /** Opaque, server-generated — from a previous page's `nextCursor`. Never a raw client-guessed
   * value the query trusts blindly: even a forged/foreign cursor only shifts the start position
   * within a query still hard-filtered to `ctx.merchantId` below, so it can never leak another
   * merchant's members (§3, §26). */
  cursor?: string | null;
}

export interface ListMembershipsPage {
  memberships: MembershipRecord[];
  /** `null` means this was the last page. */
  nextCursor: string | null;
}

function encodeMembershipCursor(joinedAtMillis: number): string {
  return Buffer.from(String(joinedAtMillis), "utf8").toString("base64url");
}

function decodeMembershipCursor(raw: string): number | null {
  try {
    const millis = Number(Buffer.from(raw, "base64url").toString("utf8"));
    return Number.isFinite(millis) ? millis : null;
  } catch {
    return null;
  }
}

/**
 * Default member list (§33 — Owner/Staff need to see the member list without already knowing a
 * name/phone/code, e.g. right after a customer joins through LINE). Server-side cursor pagination
 * on the existing `(merchantId asc, joinedAt desc)` index (already provisioned — see
 * `firestore.indexes.json`) — never loads the whole collection. Newest-first, same convention as
 * every other "recent activity" list in this codebase (audit logs, points ledger).
 */
export async function listMemberships(
  ctx: AuthContext,
  options: ListMembershipsOptions = {},
): Promise<ListMembershipsPage> {
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, ctx.merchantId);
  const pageSize = Math.min(Math.max(options.pageSize ?? MEMBER_LIST_DEFAULT_PAGE_SIZE, 1), MEMBER_LIST_MAX_PAGE_SIZE);

  let query = getDb()
    .collection(COLLECTIONS.memberships)
    .where("merchantId", "==", ctx.merchantId)
    .orderBy("joinedAt", "desc")
    .limit(pageSize);

  const cursorMillis = options.cursor ? decodeMembershipCursor(options.cursor) : null;
  if (cursorMillis !== null) {
    query = query.startAfter(Timestamp.fromMillis(cursorMillis));
  }

  const snap = await query.get();
  const memberships = snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<MembershipRecord, "id">) }));
  const last = memberships[memberships.length - 1];
  const nextCursor =
    memberships.length === pageSize && last ? encodeMembershipCursor(last.joinedAt.toMillis()) : null;

  return { memberships, nextCursor };
}

/** `memberCode` is generated uppercase (see `generateMemberCode`) — normalizing lookup input the
 * same way lets Staff Scan/Search work regardless of how the code was typed/encoded. */
function normalizeMemberCode(code: string): string {
  return code.trim().toUpperCase();
}

const PREFIX_QUERY_LIMIT = 20;

/** Very high Unicode Private Use Area code point — appending it to the upper bound turns
 * startAt/endAt into an actual prefix match rather than an exact-match range. Firestore range
 * queries have no native startsWith; `startAt(prefix).endAt(prefix + PREFIX_UPPER_BOUND)` is the
 * standard idiom. Proven as a real, previously-missing fix via a live query against staging data:
 * searching "ส" found nothing for a member actually named "สมาชิก" without this — only the exact
 * full string ever matched before. */
const PREFIX_UPPER_BOUND = String.fromCharCode(0xf8ff);

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
    .endAt(`${prefix}${PREFIX_UPPER_BOUND}`)
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
  /**
   * From `liff.getProfile()` — display-only, low-stakes (a nickname), unlike `lineUserId` never
   * used for identity/security decisions. §21's "untrusted client input" concern is about identity
   * (who this is), not cosmetic display text, matching how `STAFF_INPUT` members' `displayName` is
   * already fully staff-typed and unverified.
   *
   * `null` means "no cosmetic name available this login" (LIFF profile fetch failed, scope not
   * granted yet, etc.) — distinct from an actual empty string. On a brand-new membership this
   * falls back to a generic placeholder; on an EXISTING membership, `null` leaves
   * `merchantProfile.displayName` untouched rather than clobbering a previously-captured real name
   * back to the placeholder.
   */
  displayName: string | null;
}

const LINE_MEMBER_DEFAULT_DISPLAY_NAME = "สมาชิก";

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
 * `resolveOrCreatePlatformCustomer`, §6) rather than creating a duplicate. Identity resolution here
 * is keyed SOLELY on `(merchantId, platformCustomerId)` — `displayName` never participates in
 * finding/matching a membership, only in what gets displayed once one is found or created.
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
    // tags/activityStats. Only touches `merchantProfile.displayName` when a real cosmetic name was
    // actually provided this login — a transient LIFF profile-fetch failure must never revert an
    // already-captured real name back to the generic placeholder.
    const update: Record<string, unknown> = {
      merchantLineIdentity: {
        channelId: input.channelId,
        lineUserId: input.lineUserId,
        linkedAt: FieldValue.serverTimestamp(),
        friendshipStatus: "UNKNOWN",
      },
    };
    if (input.displayName) {
      update["merchantProfile.displayName"] = input.displayName;
    }
    await ref.update(update);
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
        displayName: input.displayName ?? LINE_MEMBER_DEFAULT_DISPLAY_NAME,
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
