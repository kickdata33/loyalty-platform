import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { reversePoints } from "@/modules/points/ledger-service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface ReverseBody {
  ledgerEntryId?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
}

/** Owner/Manager only — enforced inside `reversePoints` via `POINTS_REVERSE`. */
export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as ReverseBody;

    if (typeof body.ledgerEntryId !== "string" || body.ledgerEntryId.length === 0) {
      throw new ValidationError("ledgerEntryId is required.");
    }
    if (typeof body.reason !== "string") throw new ValidationError("reason is required.");
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await reversePoints(ctx, {
      ledgerEntryId: body.ledgerEntryId,
      reason: body.reason,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
