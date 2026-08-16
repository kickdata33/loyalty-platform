import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { createAutomation, listAutomations } from "@/modules/promotion-automation/service";
import type {
  AutomationAction,
  AutomationCondition,
  AutomationLimits,
  AutomationTrigger,
} from "@/modules/promotion-automation/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const automations = await listAutomations(ctx);
    return NextResponse.json(automations);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface CreateAutomationBody {
  name?: unknown;
  trigger?: unknown;
  conditions?: unknown;
  actions?: unknown;
  limits?: unknown;
  presentedAs?: unknown;
  marketing?: unknown;
}

function parseTrigger(value: unknown): AutomationTrigger {
  if (typeof value !== "object" || value === null) throw new ValidationError("trigger is required.");
  const v = value as { type?: unknown; config?: unknown };
  if (typeof v.type !== "string") throw new ValidationError("trigger.type is required.");
  return { type: v.type as AutomationTrigger["type"], config: (v.config as Record<string, unknown>) ?? {} };
}

function parseActions(value: unknown): AutomationAction[] {
  if (!Array.isArray(value) || value.length === 0) throw new ValidationError("actions must be a non-empty array.");
  return value.map((a) => {
    if (typeof a !== "object" || a === null || typeof (a as { type?: unknown }).type !== "string") {
      throw new ValidationError("each action requires a `type`.");
    }
    const action = a as { type: string; params?: unknown };
    return { type: action.type as AutomationAction["type"], params: (action.params as Record<string, unknown>) ?? {} };
  });
}

function parseConditions(value: unknown): AutomationCondition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("conditions must be an array.");
  return value as AutomationCondition[];
}

function parseLimits(value: unknown): AutomationLimits {
  const v = (value as Partial<AutomationLimits>) ?? {};
  return {
    maxExecPerCustomerPerDay: v.maxExecPerCustomerPerDay ?? null,
    maxExecPerPromotion: v.maxExecPerPromotion ?? null,
    pointBudget: v.pointBudget ?? null,
    couponBudget: v.couponBudget ?? null,
    cooldownHours: v.cooldownHours ?? null,
  };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as CreateAutomationBody;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new ValidationError("name is required.");
    }
    if (body.presentedAs !== "AUTOMATION" && body.presentedAs !== "PROMOTION") {
      throw new ValidationError("presentedAs must be 'AUTOMATION' or 'PROMOTION'.");
    }

    const automationId = await createAutomation(ctx, {
      name: body.name,
      trigger: parseTrigger(body.trigger),
      conditions: parseConditions(body.conditions),
      actions: parseActions(body.actions),
      limits: parseLimits(body.limits),
      presentedAs: body.presentedAs,
      marketing: body.marketing as never,
    });

    return NextResponse.json({ automationId }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
