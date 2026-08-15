import { hasPermission, type Permission } from "@/modules/rbac/permission-matrix";
import { AuthorizationError, TenantIsolationError } from "@/modules/shared/errors";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Centralized Authorization Service (FINAL-ARCHITECTURE.md §9, §10, §26).
 *
 * This is the ONLY place permission/tenant checks should be implemented. Every service function
 * that performs a merchant-scoped, business-sensitive operation must call one of these guards —
 * never re-implement an `if (role === ...)` check inline elsewhere ("ห้ามใส่ permission check
 * กระจายตาม UI component", §10, §34).
 */

/**
 * Asserts the caller has `permission` AND that `resourceMerchantId` (loaded from the resource
 * being acted on — never from unvalidated client input, §10) matches the caller's own
 * `merchantId`. Tenant isolation is checked first and always, even when the permission check
 * would also fail, so a cross-tenant attempt is never masked as an ordinary permission denial.
 */
export function requirePermission(
  ctx: AuthContext,
  permission: Permission,
  resourceMerchantId: string,
): void {
  if (ctx.merchantId !== resourceMerchantId) {
    throw new TenantIsolationError(
      `Staff of merchant ${ctx.merchantId} attempted to access a resource of merchant ${resourceMerchantId}.`,
    );
  }
  if (!hasPermission(ctx.role, permission)) {
    throw new AuthorizationError(
      `Role ${ctx.role} does not have permission ${permission}.`,
    );
  }
}

/**
 * Guard for actions Manager cannot perform even with a broad permission like STAFF_MANAGE — e.g.
 * editing the Owner's own StaffUser record (§9, §10: "guard สำหรับ action ที่ Manager ทำไม่ได้
 * แม้จะมี MANAGE_STAFF กว้างๆ"). Still checks tenant isolation first.
 */
export function requireOwner(ctx: AuthContext, resourceMerchantId: string): void {
  if (ctx.merchantId !== resourceMerchantId) {
    throw new TenantIsolationError(
      `Staff of merchant ${ctx.merchantId} attempted to access a resource of merchant ${resourceMerchantId}.`,
    );
  }
  if (ctx.role !== "OWNER") {
    throw new AuthorizationError("This action requires the Owner role.");
  }
}

/**
 * Asserts a staff member is allowed to act on `branchId`. An empty `branchScope` means
 * unrestricted (all branches) — FINAL-ARCHITECTURE.md §11.
 */
export function requireBranchScope(
  staff: Pick<AuthContext, "branchScope">,
  branchId: string,
): void {
  if (staff.branchScope.length === 0) return;
  if (!staff.branchScope.includes(branchId)) {
    throw new AuthorizationError(`Staff is not scoped to branch ${branchId}.`);
  }
}
