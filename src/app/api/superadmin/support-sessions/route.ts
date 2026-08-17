import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { openSupportSession } from "@/modules/support-session/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface OpenSupportSessionRequestBody {
  merchantId?: unknown;
  reason?: unknown;
  ttlMinutes?: unknown;
}

/** Opens a new Support Session (§37.1) — Super Admin only. `merchantId`/`reason` are required;
 * `ttlMinutes` is optional and clamped server-side. */
export async function POST(request: Request) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as OpenSupportSessionRequestBody;

    if (typeof body.merchantId !== "string" || body.merchantId.trim().length === 0) {
      throw new ValidationError("merchantId is required.");
    }
    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      throw new ValidationError("reason is required.");
    }
    const ttlMinutes = typeof body.ttlMinutes === "number" ? body.ttlMinutes : undefined;

    const result = await openSupportSession(admin, { merchantId: body.merchantId, reason: body.reason, ttlMinutes });
    return NextResponse.json({
      sessionId: result.sessionId,
      expiresAt: result.expiresAt.toDate().toISOString(),
    });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
