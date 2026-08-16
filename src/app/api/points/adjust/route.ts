import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { adjustPoints } from "@/modules/points/ledger-service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface AdjustBody {
  membershipId?: unknown;
  delta?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

/** Owner/Manager only — enforced inside `adjustPoints` via `POINTS_ADJUST`. */
export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as AdjustBody;

    if (typeof body.membershipId !== "string" || body.membershipId.length === 0) {
      throw new ValidationError("membershipId is required.");
    }
    if (typeof body.delta !== "number") throw new ValidationError("delta must be a number.");
    if (typeof body.reason !== "string") throw new ValidationError("reason is required.");
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await adjustPoints(ctx, {
      membershipId: body.membershipId,
      delta: body.delta,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
