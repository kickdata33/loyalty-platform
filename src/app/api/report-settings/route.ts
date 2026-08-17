import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getReportSettings, updateReportSettings } from "@/modules/report/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const settings = await getReportSettings(ctx);
    return NextResponse.json(settings);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    if (
      typeof body.dailyEnabled !== "boolean" ||
      typeof body.weeklyEnabled !== "boolean" ||
      typeof body.monthlyEnabled !== "boolean"
    ) {
      throw new ValidationError("dailyEnabled, weeklyEnabled, monthlyEnabled must be booleans.");
    }
    if (!Array.isArray(body.dailyItems) || !Array.isArray(body.weeklyItems) || !Array.isArray(body.monthlyItems)) {
      throw new ValidationError("dailyItems, weeklyItems, monthlyItems must be arrays.");
    }

    await updateReportSettings(ctx, {
      dailyEnabled: body.dailyEnabled,
      weeklyEnabled: body.weeklyEnabled,
      monthlyEnabled: body.monthlyEnabled,
      dailyItems: body.dailyItems as never,
      weeklyItems: body.weeklyItems as never,
      monthlyItems: body.monthlyItems as never,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
