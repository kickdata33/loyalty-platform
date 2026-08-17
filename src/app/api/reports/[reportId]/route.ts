import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getReport } from "@/modules/report/service";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { reportId } = await params;
    const report = await getReport(ctx, reportId);
    return NextResponse.json(report);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
