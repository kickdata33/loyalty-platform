import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { getAutomation, updateAutomation } from "@/modules/promotion-automation/service";
import type { AutomationAction, AutomationCondition, AutomationLimits, AutomationTrigger } from "@/modules/promotion-automation/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ automationId: string }> }) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { automationId } = await params;
    const automation = await getAutomation(ctx, automationId);
    return NextResponse.json(automation);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface UpdateAutomationBody {
  name?: unknown;
  trigger?: unknown;
  conditions?: unknown;
  actions?: unknown;
  limits?: unknown;
  presentedAs?: unknown;
  marketing?: unknown;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ automationId: string }> }) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const { automationId } = await params;
    const body = (await request.json().catch(() => ({}))) as UpdateAutomationBody;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new ValidationError("name is required.");
    }
    if (body.presentedAs !== "AUTOMATION" && body.presentedAs !== "PROMOTION") {
      throw new ValidationError("presentedAs must be 'AUTOMATION' or 'PROMOTION'.");
    }
    if (typeof body.trigger !== "object" || body.trigger === null) throw new ValidationError("trigger is required.");
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      throw new ValidationError("actions must be a non-empty array.");
    }

    await updateAutomation(ctx, automationId, {
      name: body.name,
      trigger: body.trigger as AutomationTrigger,
      conditions: (body.conditions as AutomationCondition[]) ?? [],
      actions: body.actions as AutomationAction[],
      limits: (body.limits as AutomationLimits) ?? {
        maxExecPerCustomerPerDay: null,
        maxExecPerPromotion: null,
        pointBudget: null,
        couponBudget: null,
        cooldownHours: null,
      },
      presentedAs: body.presentedAs,
      marketing: body.marketing as never,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
