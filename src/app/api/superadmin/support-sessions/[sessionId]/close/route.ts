import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { closeSupportSession } from "@/modules/support-session/service";

export const runtime = "nodejs";

/** Deterministic, immediate revocation (§37.1) — the "Exit Support Mode" action. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const { sessionId } = await params;
    await closeSupportSession(admin, sessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
