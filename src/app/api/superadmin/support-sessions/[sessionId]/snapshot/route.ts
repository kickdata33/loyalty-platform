import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getSupportSnapshot } from "@/modules/support-session/service";

export const runtime = "nodejs";

/** Read-only "View-as" snapshot for an active Support Session (§37.1) — audited on every call. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const { sessionId } = await params;
    const snapshot = await getSupportSnapshot(admin, sessionId);
    return NextResponse.json(snapshot);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
