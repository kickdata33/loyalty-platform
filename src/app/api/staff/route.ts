import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getAdminAuth } from "@/lib/firebase/admin";
import { createStaffUser, listStaff } from "@/modules/staff/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/**
 * Enriches each StaffUserRecord with its email for display — `StaffUserRecord` itself only has
 * `authUid` (§5 schema has no email field on staffUsers), so this route-level presentation step
 * looks emails up via a single batched Admin Auth call. Not a service-layer change.
 */
export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const staff = await listStaff(ctx);

    if (staff.length === 0) return NextResponse.json([]);

    const { users } = await getAdminAuth().getUsers(staff.map((s) => ({ uid: s.authUid })));
    const emailByUid = new Map(users.map((u) => [u.uid, u.email ?? null]));

    return NextResponse.json(
      staff.map((s) => ({ ...s, email: emailByUid.get(s.authUid) ?? null })),
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface CreateStaffRequestBody {
  email?: unknown;
  role?: unknown;
}

/**
 * POST /api/staff — add a Manager/Staff to the caller's own merchant.
 *
 * `createStaffUser` (Phase 1) requires the target's Firebase Auth `uid`, but the UI only has
 * their email — this route translates email → uid via `getAdminAuth().getUserByEmail()` before
 * calling the service function. This is input validation/translation at the API-route layer, not
 * new business logic: the actual permission/role rules are unchanged, still entirely inside
 * `createStaffUser`. The person being added must already have created their own account (there is
 * no invite-and-auto-provision flow in Phase 1/2).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as CreateStaffRequestBody;

    if (typeof body.email !== "string" || body.email.trim().length === 0) {
      throw new ValidationError("email is required.");
    }
    if (body.role !== "MANAGER" && body.role !== "STAFF") {
      throw new ValidationError("role must be 'MANAGER' or 'STAFF'.");
    }

    let authUid: string;
    try {
      const userRecord = await getAdminAuth().getUserByEmail(body.email);
      authUid = userRecord.uid;
    } catch {
      throw new ValidationError(
        "No account found for this email. The person must create an account first (via Sign Up) before you can add them as staff.",
      );
    }

    const staffUserId = await createStaffUser(ctx, { authUid, role: body.role });
    return NextResponse.json({ staffUserId }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
