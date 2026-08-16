import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { sendBroadcast, sendTestBroadcast } from "@/modules/notification/service";
import type { BroadcastAudience, NotificationTemplateType } from "@/modules/notification/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

const VALID_AUDIENCES = ["ALL", "ACTIVE", "AT_RISK", "INACTIVE", "VIP"];

function parseAudience(value: unknown): BroadcastAudience {
  if (typeof value === "string" && VALID_AUDIENCES.includes(value)) return value as BroadcastAudience;
  if (typeof value === "object" && value !== null && "pointsGte" in value) {
    return { pointsGte: Number((value as { pointsGte: unknown }).pointsGte) };
  }
  throw new ValidationError(`audience must be one of ${VALID_AUDIENCES.join(", ")} or {pointsGte: number}.`);
}

interface BroadcastBody {
  mode?: unknown; // "send" | "test"
  audience?: unknown;
  templateType?: unknown;
  variables?: unknown;
  testBody?: unknown;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as BroadcastBody;

    if (body.mode === "test") {
      if (typeof body.testBody !== "string" || body.testBody.trim().length === 0) {
        throw new ValidationError("testBody is required for mode='test'.");
      }
      await sendTestBroadcast(ctx, body.testBody);
      return NextResponse.json({ ok: true });
    }

    if (typeof body.templateType !== "string") throw new ValidationError("templateType is required.");
    const result = await sendBroadcast(ctx, {
      audience: parseAudience(body.audience),
      templateType: body.templateType as NotificationTemplateType,
      variables: (body.variables as Record<string, string | number>) ?? {},
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
