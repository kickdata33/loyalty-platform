import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { issueCouponManual } from "@/modules/coupon/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface IssueBody {
  membershipId?: unknown;
  couponTemplateId?: unknown;
  branchId?: unknown;
  visitSource?: unknown;
  idempotencyKey?: unknown;
}

/** Manual distribution — Owner/Manager only, enforced inside `issueCouponManual` via
 * `COUPON_MANAGE` (never `COUPON_REDEEM`, which Staff also holds — see the module doc comment). */
export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as IssueBody;

    if (typeof body.membershipId !== "string" || body.membershipId.length === 0) {
      throw new ValidationError("membershipId is required.");
    }
    if (typeof body.couponTemplateId !== "string" || body.couponTemplateId.length === 0) {
      throw new ValidationError("couponTemplateId is required.");
    }
    if (body.visitSource !== "STAFF_SCAN" && body.visitSource !== "STAFF_SEARCH") {
      throw new ValidationError("visitSource must be 'STAFF_SCAN' or 'STAFF_SEARCH'.");
    }
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await issueCouponManual(ctx, {
      membershipId: body.membershipId,
      couponTemplateId: body.couponTemplateId,
      branchId: typeof body.branchId === "string" ? body.branchId : null,
      visitSource: body.visitSource,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
