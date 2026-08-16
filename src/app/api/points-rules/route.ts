import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { createPointRule, listPointRules } from "@/modules/points/rule-engine";
import type { PointRuleConfig, PointRuleType } from "@/modules/points/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const rules = await listPointRules(ctx);
    return NextResponse.json(rules);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface CreateRuleBody {
  name?: unknown;
  type?: unknown;
  config?: unknown;
  branchScope?: unknown;
  priority?: unknown;
  stackingPolicy?: unknown;
}

const VALID_TYPES = ["PER_UNIT", "PER_VISIT", "AMOUNT_BASED", "BONUS_EVENT", "MULTIPLIER"];

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as CreateRuleBody;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new ValidationError("name is required.");
    }
    if (typeof body.type !== "string" || !VALID_TYPES.includes(body.type)) {
      throw new ValidationError(`type must be one of ${VALID_TYPES.join(", ")}.`);
    }
    if (typeof body.config !== "object" || body.config === null) {
      throw new ValidationError("config is required.");
    }

    const ruleId = await createPointRule(ctx, {
      name: body.name,
      type: body.type as PointRuleType,
      config: body.config as PointRuleConfig,
      branchScope: Array.isArray(body.branchScope) ? (body.branchScope as string[]) : undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      stackingPolicy:
        body.stackingPolicy === "ADDITIVE" ||
        body.stackingPolicy === "HIGHEST_ONLY" ||
        body.stackingPolicy === "MULTIPLICATIVE"
          ? body.stackingPolicy
          : undefined,
    });

    return NextResponse.json({ ruleId }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
