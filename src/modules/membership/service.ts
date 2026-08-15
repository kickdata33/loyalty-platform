import { FieldValue } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { createPlatformCustomer } from "@/modules/identity/service";
import { requireBranchScope, requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { MembershipRecord } from "@/modules/membership/types";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";
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
  await ref.set({
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

export async function listMemberships(ctx: AuthContext): Promise<MembershipRecord[]> {
  requirePermission(ctx, PERMISSIONS.MEMBER_VIEW, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.memberships)
    .where("merchantId", "==", ctx.merchantId)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<MembershipRecord, "id">) }));
}
