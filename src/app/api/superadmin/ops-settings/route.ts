import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getCriticalAlertSettings, setCriticalAlertSettings } from "@/modules/ops-alert/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/** GET/POST the platform-wide critical alert recipient (§38.2) — Super Admin only. Stored for
 * forward compatibility only — live LINE delivery is currently deferred (§38.2 addendum, Option
 * B, locked); see `@/modules/ops-alert/service`. */
export async function GET(request: Request) {
  try {
    await requireSuperAdminAuthContext(request);
    const settings = await getCriticalAlertSettings();
    return NextResponse.json(settings);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface SetOpsSettingsRequestBody {
  lineUserId?: unknown;
  reason?: unknown;
}

export async function POST(request: Request) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as SetOpsSettingsRequestBody;

    if (body.lineUserId !== null && typeof body.lineUserId !== "string") {
      throw new ValidationError("lineUserId must be a string or null.");
    }
    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      throw new ValidationError("reason is required.");
    }

    await setCriticalAlertSettings(admin, { lineUserId: body.lineUserId }, body.reason);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
