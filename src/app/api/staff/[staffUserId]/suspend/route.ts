import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { suspendStaffUser } from "@/modules/staff/service";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ staffUserId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { staffUserId } = await params;
    await suspendStaffUser(ctx, staffUserId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
