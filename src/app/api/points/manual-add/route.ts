import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { addManualPoints } from "@/modules/points/ledger-service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface ManualAddBody {
  membershipId?: unknown;
  branchId?: unknown;
  amount?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as ManualAddBody;

    if (typeof body.membershipId !== "string" || body.membershipId.length === 0) {
      throw new ValidationError("membershipId is required.");
    }
    if (typeof body.amount !== "number") throw new ValidationError("amount must be a number.");
    if (typeof body.reason !== "string") throw new ValidationError("reason is required.");
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await addManualPoints(ctx, {
      membershipId: body.membershipId,
      branchId: typeof body.branchId === "string" ? body.branchId : null,
      amount: body.amount,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
