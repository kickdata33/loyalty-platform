import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { confirmRedemptionIntent } from "@/modules/reward/redemption-intent";

export const runtime = "nodejs";

interface ConfirmBody {
  branchId?: unknown;
}

/** Staff's explicit confirm — the only step that actually redeems the reward and deducts points
 * (via the existing `redeemReward()`, atomically). `branchId` is optional, same convention as
 * `/api/rewards/redeem`. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { intentId } = await params;
    const body = (await request.json().catch(() => ({}))) as ConfirmBody;
    const branchId = typeof body.branchId === "string" ? body.branchId : null;

    const result = await confirmRedemptionIntent(ctx, intentId, branchId);
    return NextResponse.json(result);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
