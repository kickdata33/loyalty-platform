import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getLineChannelStatus } from "@/modules/line-channel/service";

export const runtime = "nodejs";

/** Owner-only — never returns secret/token values, only connection status (see
 * `getLineChannelStatus`). */
export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const status = await getLineChannelStatus(ctx);
    return NextResponse.json(status);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
