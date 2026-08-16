import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { dryRunAutomation } from "@/modules/promotion-automation/service";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ automationId: string }> }) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { automationId } = await params;
    const result = await dryRunAutomation(ctx, automationId);
    return NextResponse.json(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
