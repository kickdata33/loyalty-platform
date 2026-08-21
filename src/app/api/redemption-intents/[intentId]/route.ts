import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getRedemptionIntentPreview } from "@/modules/reward/redemption-intent";

export const runtime = "nodejs";

/** Staff scans the member's redemption QR (existing dashboard scanner, same as the member-lookup
 * scan flow) -> this returns what staff needs to see before confirming: member name, reward name,
 * points cost, and the member's CURRENT balance. Read-only — never mutates the intent. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ intentId: string }> },
) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { intentId } = await params;
    const preview = await getRedemptionIntentPreview(ctx, intentId);
    return NextResponse.json(preview);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
