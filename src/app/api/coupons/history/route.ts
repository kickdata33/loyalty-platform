import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getCouponHistory } from "@/modules/coupon/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const membershipId = new URL(request.url).searchParams.get("membershipId");
    if (!membershipId) throw new ValidationError("membershipId query param is required.");

    const history = await getCouponHistory(ctx, membershipId);
    return NextResponse.json(history);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
