import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import {
  EMERGENCY_CAPABILITIES,
  type EmergencyCapability,
} from "@/modules/emergency-control/types";
import { getEmergencyControls, setEmergencyControl } from "@/modules/emergency-control/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ merchantId: string }> },
) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const { merchantId } = await params;
    const record = await getEmergencyControls(admin, merchantId);
    return NextResponse.json(record);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface SetEmergencyControlRequestBody {
  capability?: unknown;
  enabled?: unknown;
  reason?: unknown;
}

function isEmergencyCapability(value: unknown): value is EmergencyCapability {
  return typeof value === "string" && (EMERGENCY_CAPABILITIES as readonly string[]).includes(value);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string }> },
) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const { merchantId } = await params;
    const body = (await request.json().catch(() => ({}))) as SetEmergencyControlRequestBody;

    if (!isEmergencyCapability(body.capability)) {
      throw new ValidationError(`capability must be one of: ${EMERGENCY_CAPABILITIES.join(", ")}`);
    }
    if (typeof body.enabled !== "boolean") {
      throw new ValidationError("enabled must be a boolean.");
    }
    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      throw new ValidationError("reason is required.");
    }

    await setEmergencyControl(admin, merchantId, body.capability, body.enabled, body.reason);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
