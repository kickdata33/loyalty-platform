import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { issueCouponToSegment } from "@/modules/coupon/service";
import type { Segment } from "@/modules/membership/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

const VALID_SEGMENTS = ["NEW", "ACTIVE", "REGULAR", "VIP", "AT_RISK", "INACTIVE"];

interface IssueSegmentBody {
  couponTemplateId?: unknown;
  targetSegment?: unknown;
  idempotencyKey?: unknown;
}

/** Segment distribution — Owner/Manager only, `COUPON_MANAGE` (same boundary as manual issue). */
export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as IssueSegmentBody;

    if (typeof body.couponTemplateId !== "string" || body.couponTemplateId.length === 0) {
      throw new ValidationError("couponTemplateId is required.");
    }
    if (typeof body.targetSegment !== "string" || !VALID_SEGMENTS.includes(body.targetSegment)) {
      throw new ValidationError(`targetSegment must be one of ${VALID_SEGMENTS.join(", ")}.`);
    }
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await issueCouponToSegment(ctx, {
      couponTemplateId: body.couponTemplateId,
      targetSegment: body.targetSegment as Segment,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
