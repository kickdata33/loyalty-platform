import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getMerchant } from "@/modules/merchant/service";

export const runtime = "nodejs";

/** GET /api/merchant — the caller's own merchant. No `merchantId` in the URL/query on purpose:
 * a Staff/Owner always acts within exactly their own merchant (from `ctx.merchantId`), so there
 * is nothing for a client-supplied id to override. */
export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const merchant = await getMerchant(ctx, ctx.merchantId);
    return NextResponse.json(merchant);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
