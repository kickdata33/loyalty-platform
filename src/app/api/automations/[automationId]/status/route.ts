import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { setAutomationStatus } from "@/modules/promotion-automation/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

const VALID_STATUSES = ["DRAFT", "TEST", "ACTIVE", "PAUSED", "ENDED"];

export async function PATCH(request: Request, { params }: { params: Promise<{ automationId: string }> }) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { automationId } = await params;
    const body = (await request.json().catch(() => ({}))) as { status?: unknown };
    if (typeof body.status !== "string" || !VALID_STATUSES.includes(body.status)) {
      throw new ValidationError(`status must be one of ${VALID_STATUSES.join(", ")}.`);
    }

    await setAutomationStatus(ctx, automationId, body.status as never);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
