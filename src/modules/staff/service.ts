import { writeAuditLog } from "@/modules/audit/service";
import { enforceEntitlementLimitTx } from "@/modules/billing-entitlement/service";
import { requireOwner, requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { StaffUserRecord } from "@/modules/staff/types";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext, Role } from "@/modules/shared/types";

/**
 * Staff/Owner management (FINAL-ARCHITECTURE.md §9, §10). Every write here targets
 * `staffUsers/{id}` — the ONLY document Firebase Auth custom claims are ever derived from, via
 * the `onStaffUserWrite` Cloud Function trigger (§8, §32, `functions/src/index.ts`). This module
 * never calls `auth.setCustomUserClaims` itself.
 *
 * `merchantId` is always taken from `ctx` (the caller's own verified auth context), never
 * accepted as an input field — a StaffUser can only ever be created/modified within the caller's
 * own merchant (§3, §26).
 */

type AssignableRole = Exclude<Role, "OWNER">;

function assertAssignableRole(role: string): asserts role is AssignableRole {
  if (role !== "MANAGER" && role !== "STAFF") {
    throw new ValidationError(
      "role must be 'MANAGER' or 'STAFF' — the Owner role can only be set by createMerchantWithOwner.",
    );
  }
}

async function getStaffUserOrThrow(staffUserId: string): Promise<StaffUserRecord> {
  const snap = await getDb().collection(COLLECTIONS.staffUsers).doc(staffUserId).get();
  if (!snap.exists) throw new NotFoundError(`StaffUser ${staffUserId} not found.`);
  return { id: snap.id, ...(snap.data() as Omit<StaffUserRecord, "id">) };
}

/**
 * Guards against Manager touching the Owner's own StaffUser record even though Manager holds the
 * broad STAFF_MANAGE permission (§9, §10: "guard สำหรับ action ที่ Manager ทำไม่ได้แม้จะมี
 * MANAGE_STAFF กว้างๆ").
 */
function requireStaffManagePermissionFor(ctx: AuthContext, target: StaffUserRecord): void {
  if (target.role === "OWNER") {
    requireOwner(ctx, target.merchantId);
  } else {
    requirePermission(ctx, PERMISSIONS.STAFF_MANAGE, target.merchantId);
  }
}

export interface CreateStaffUserInput {
  authUid: string;
  role: AssignableRole;
  branchScope?: string[];
}

export async function createStaffUser(
  ctx: AuthContext,
  input: CreateStaffUserInput,
): Promise<string> {
  requirePermission(ctx, PERMISSIONS.STAFF_MANAGE, ctx.merchantId);
  assertAssignableRole(input.role);
  if (input.authUid.trim().length === 0) {
    throw new ValidationError("authUid must not be empty.");
  }

  const db = getDb();
  const ref = db.collection(COLLECTIONS.staffUsers).doc();

  // The duplicate-authUid check runs *inside* the transaction (as a query read, same pattern as
  // the merchant-slug uniqueness check in merchant/service.ts) so two concurrent createStaffUser
  // calls for the same person can't both slip past the check and create two StaffUser docs for
  // one authUid — Firestore's transaction conflict detection retries the loser, and its retry
  // observes the winner's now-existing document.
  await db.runTransaction(async (tx) => {
    // Entitlement Limit Enforcement (§37.3, Locked) — must run before any write in this
    // transaction (Firestore: all reads before all writes).
    await enforceEntitlementLimitTx(tx, ctx.merchantId, "staff");

    const dupQuery = db
      .collection(COLLECTIONS.staffUsers)
      .where("merchantId", "==", ctx.merchantId)
      .where("authUid", "==", input.authUid)
      .limit(1);
    const existing = await tx.get(dupQuery);
    if (!existing.empty) {
      throw new ValidationError("This account is already a staff member of this merchant.");
    }

    tx.create(ref, {
      merchantId: ctx.merchantId,
      authUid: input.authUid,
      role: input.role,
      permissionOverrides: [],
      branchScope: input.branchScope ?? [],
      status: "ACTIVE",
    });
  });

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "staff.created",
    targetType: "staffUser",
    targetId: ref.id,
    after: { authUid: input.authUid, role: input.role },
  });

  return ref.id;
}

export async function updateStaffRole(
  ctx: AuthContext,
  targetStaffUserId: string,
  newRole: AssignableRole,
): Promise<void> {
  assertAssignableRole(newRole);
  const target = await getStaffUserOrThrow(targetStaffUserId);
  requireStaffManagePermissionFor(ctx, target);

  await getDb().collection(COLLECTIONS.staffUsers).doc(targetStaffUserId).update({ role: newRole });

  await writeAuditLog({
    merchantId: target.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "staff.role_updated",
    targetType: "staffUser",
    targetId: targetStaffUserId,
    before: { role: target.role },
    after: { role: newRole },
  });
}

async function setStaffStatus(
  ctx: AuthContext,
  targetStaffUserId: string,
  status: "ACTIVE" | "SUSPENDED",
): Promise<void> {
  const target = await getStaffUserOrThrow(targetStaffUserId);
  requireStaffManagePermissionFor(ctx, target);

  await getDb().collection(COLLECTIONS.staffUsers).doc(targetStaffUserId).update({ status });

  await writeAuditLog({
    merchantId: target.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: status === "SUSPENDED" ? "staff.suspended" : "staff.reinstated",
    targetType: "staffUser",
    targetId: targetStaffUserId,
    before: { status: target.status },
    after: { status },
  });
}

export const suspendStaffUser = (ctx: AuthContext, targetStaffUserId: string) =>
  setStaffStatus(ctx, targetStaffUserId, "SUSPENDED");

export const reinstateStaffUser = (ctx: AuthContext, targetStaffUserId: string) =>
  setStaffStatus(ctx, targetStaffUserId, "ACTIVE");

export async function listStaff(ctx: AuthContext): Promise<StaffUserRecord[]> {
  requirePermission(ctx, PERMISSIONS.STAFF_MANAGE, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.staffUsers)
    .where("merchantId", "==", ctx.merchantId)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<StaffUserRecord, "id">) }));
}
