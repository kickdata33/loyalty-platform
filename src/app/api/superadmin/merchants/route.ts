import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { listMerchantsForSuperAdmin } from "@/modules/merchant/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireSuperAdminAuthContext(request);
    const merchants = await listMerchantsForSuperAdmin();
    return NextResponse.json(merchants);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
