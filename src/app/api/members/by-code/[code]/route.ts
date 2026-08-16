import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getMembershipByCode } from "@/modules/membership/service";

export const runtime = "nodejs";

/** Staff Scan flow — the camera-decoded QR value (a `memberCode`) is looked up here. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { code } = await params;
    const membership = await getMembershipByCode(ctx, decodeURIComponent(code));
    return NextResponse.json(membership);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
