import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { createBranch, listBranches } from "@/modules/merchant/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const branches = await listBranches(ctx, ctx.merchantId);
    return NextResponse.json(branches);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface CreateBranchRequestBody {
  name?: unknown;
  address?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as CreateBranchRequestBody;
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new ValidationError("name is required.");
    }

    // merchantId always ctx.merchantId — never accepted from the request body.
    const branchId = await createBranch(ctx, {
      merchantId: ctx.merchantId,
      name: body.name,
      address: typeof body.address === "string" ? body.address : "",
    });
    return NextResponse.json({ branchId }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
