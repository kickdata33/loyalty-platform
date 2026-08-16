import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { searchMemberships } from "@/modules/membership/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const q = new URL(request.url).searchParams.get("q") ?? "";
    const results = await searchMemberships(ctx, q);
    return NextResponse.json(results);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
