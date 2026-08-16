import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getNotificationSettings, updateNotificationSettings } from "@/modules/notification/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const settings = await getNotificationSettings(ctx);
    return NextResponse.json(settings);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as { templates?: unknown; testRecipientLineUserId?: unknown };
    if (typeof body.templates !== "object" || body.templates === null) {
      throw new ValidationError("templates is required.");
    }
    await updateNotificationSettings(ctx, {
      templates: body.templates as never,
      testRecipientLineUserId: typeof body.testRecipientLineUserId === "string" ? body.testRecipientLineUserId : null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
