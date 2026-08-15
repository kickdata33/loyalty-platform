import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { updateStaffRole } from "@/modules/staff/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface UpdateRoleRequestBody {
  role?: unknown;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ staffUserId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { staffUserId } = await params;
    const body = (await request.json().catch(() => ({}))) as UpdateRoleRequestBody;

    if (body.role !== "MANAGER" && body.role !== "STAFF") {
      throw new ValidationError("role must be 'MANAGER' or 'STAFF'.");
    }

    // updateStaffRole loads the target StaffUser server-side and authorizes against ITS actual
    // merchantId (§10) — a staffUserId belonging to a different merchant correctly throws
    // TenantIsolationError here, not a silent no-op.
    await updateStaffRole(ctx, staffUserId, body.role);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
