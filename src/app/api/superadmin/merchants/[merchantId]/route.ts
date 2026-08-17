import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getMerchantDetailForSuperAdmin } from "@/modules/merchant/service";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ merchantId: string }> },
) {
  try {
    await requireSuperAdminAuthContext(request);
    const { merchantId } = await params;
    const detail = await getMerchantDetailForSuperAdmin(merchantId);
    return NextResponse.json(detail);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
