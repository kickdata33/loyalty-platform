import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { setCouponTemplateEnabled } from "@/modules/coupon/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ couponId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { couponId } = await params;
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") throw new ValidationError("enabled must be a boolean.");

    await setCouponTemplateEnabled(ctx, couponId, body.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
