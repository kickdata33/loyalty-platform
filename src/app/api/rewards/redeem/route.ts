import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { redeemReward } from "@/modules/reward/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface RedeemBody {
  membershipId?: unknown;
  rewardTemplateId?: unknown;
  branchId?: unknown;
  visitSource?: unknown;
  idempotencyKey?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as RedeemBody;

    if (typeof body.membershipId !== "string" || body.membershipId.length === 0) {
      throw new ValidationError("membershipId is required.");
    }
    if (typeof body.rewardTemplateId !== "string" || body.rewardTemplateId.length === 0) {
      throw new ValidationError("rewardTemplateId is required.");
    }
    if (body.visitSource !== "STAFF_SCAN" && body.visitSource !== "STAFF_SEARCH") {
      throw new ValidationError("visitSource must be 'STAFF_SCAN' or 'STAFF_SEARCH'.");
    }
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await redeemReward(ctx, {
      membershipId: body.membershipId,
      rewardTemplateId: body.rewardTemplateId,
      branchId: typeof body.branchId === "string" ? body.branchId : null,
      visitSource: body.visitSource,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
