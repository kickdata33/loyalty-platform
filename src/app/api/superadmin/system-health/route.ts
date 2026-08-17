import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getSystemHealth } from "@/modules/system-health/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireSuperAdminAuthContext(request);
    const components = await getSystemHealth();
    return NextResponse.json(components);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
