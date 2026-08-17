import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { listReports } from "@/modules/report/service";
import type { ReportType } from "@/modules/report/types";

export const runtime = "nodejs";

const VALID_TYPES: ReportType[] = ["daily", "weekly", "monthly"];

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const url = new URL(request.url);
    const typeParam = url.searchParams.get("type");
    const type = typeParam && VALID_TYPES.includes(typeParam as ReportType) ? (typeParam as ReportType) : undefined;

    const reports = await listReports(ctx, { type });
    return NextResponse.json({ reports });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
