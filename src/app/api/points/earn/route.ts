import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { earnPointsByRule } from "@/modules/points/ledger-service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface EarnBody {
  membershipId?: unknown;
  branchId?: unknown;
  sourceType?: unknown;
  units?: unknown;
  visitSource?: unknown;
  idempotencyKey?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as EarnBody;

    if (typeof body.membershipId !== "string" || body.membershipId.length === 0) {
      throw new ValidationError("membershipId is required.");
    }
    if (body.sourceType !== "PER_UNIT" && body.sourceType !== "PER_VISIT") {
      throw new ValidationError("sourceType must be 'PER_UNIT' or 'PER_VISIT'.");
    }
    if (body.visitSource !== "STAFF_SCAN" && body.visitSource !== "STAFF_SEARCH") {
      throw new ValidationError("visitSource must be 'STAFF_SCAN' or 'STAFF_SEARCH'.");
    }
    if (typeof body.idempotencyKey !== "string") {
      throw new ValidationError("idempotencyKey is required.");
    }

    const result = await earnPointsByRule(ctx, {
      membershipId: body.membershipId,
      branchId: typeof body.branchId === "string" ? body.branchId : null,
      sourceType: body.sourceType,
      units: typeof body.units === "number" ? body.units : undefined,
      visitSource: body.visitSource,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
