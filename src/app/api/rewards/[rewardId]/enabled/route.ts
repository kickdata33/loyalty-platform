import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { setRewardTemplateEnabled } from "@/modules/reward/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ rewardId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { rewardId } = await params;
    const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") throw new ValidationError("enabled must be a boolean.");

    await setRewardTemplateEnabled(ctx, rewardId, body.enabled);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
