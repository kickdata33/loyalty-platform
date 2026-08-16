import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { confirmVoucherUse } from "@/modules/reward/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface UseBody {
  voucherId?: unknown;
  branchId?: unknown;
  visitSource?: unknown;
  idempotencyKey?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as UseBody;

    if (typeof body.voucherId !== "string" || body.voucherId.length === 0) {
      throw new ValidationError("voucherId is required.");
    }
    if (body.visitSource !== "STAFF_SCAN" && body.visitSource !== "STAFF_SEARCH") {
      throw new ValidationError("visitSource must be 'STAFF_SCAN' or 'STAFF_SEARCH'.");
    }
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await confirmVoucherUse(ctx, {
      voucherId: body.voucherId,
      branchId: typeof body.branchId === "string" ? body.branchId : null,
      visitSource: body.visitSource,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
