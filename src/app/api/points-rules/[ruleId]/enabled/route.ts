import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { setPointRuleEnabled } from "@/modules/points/rule-engine";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ ruleId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { ruleId } = await params;
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") throw new ValidationError("enabled must be a boolean.");

    await setPointRuleEnabled(ctx, ruleId, body.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
