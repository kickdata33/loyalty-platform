import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { createRewardTemplate, listRewardTemplates } from "@/modules/reward/service";
import type { RewardType, VoucherExpiryRule } from "@/modules/reward/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const rewards = await listRewardTemplates(ctx);
    return NextResponse.json(rewards);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface CreateRewardBody {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  requiredPoints?: unknown;
  stock?: unknown;
  limitPerMember?: unknown;
  branchScope?: unknown;
  voucherExpiryRule?: unknown;
  startAt?: unknown;
  endAt?: unknown;
}

const VALID_TYPES = [
  "FIXED_DISCOUNT",
  "PERCENTAGE_DISCOUNT",
  "FREE_PRODUCT",
  "FREE_SERVICE",
  "PRIVILEGE",
  "PHYSICAL_REWARD",
  "CUSTOM",
];

function parseVoucherExpiryRule(value: unknown): VoucherExpiryRule | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { type?: unknown; days?: unknown; date?: unknown };
  if (v.type === "NEVER") return { type: "NEVER" };
  if (v.type === "DAYS_AFTER_REDEMPTION" && typeof v.days === "number") {
    return { type: "DAYS_AFTER_REDEMPTION", days: v.days };
  }
  // FIXED_DATE requires a real Firestore Timestamp, not constructible from a plain request body
  // field — reject rather than silently falling back, matching the rest of this codebase's
  // "never guess a business rule" posture.
  throw new ValidationError("voucherExpiryRule must be NEVER or DAYS_AFTER_REDEMPTION (with a positive `days`).");
}

/** §13 "Start/End Date" — accepts an ISO 8601 date string (how a JS `Date` round-trips through
 * JSON), rejects anything else outright rather than silently ignoring a malformed value. */
function parseOptionalDate(value: unknown, fieldName: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${fieldName} must be an ISO date string.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${fieldName} must be a valid date.`);
  return date;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as CreateRewardBody;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new ValidationError("name is required.");
    }
    if (typeof body.type !== "string" || !VALID_TYPES.includes(body.type)) {
      throw new ValidationError(`type must be one of ${VALID_TYPES.join(", ")}.`);
    }
    if (typeof body.requiredPoints !== "number") {
      throw new ValidationError("requiredPoints must be a number.");
    }

    const rewardId = await createRewardTemplate(ctx, {
      name: body.name,
      description: typeof body.description === "string" ? body.description : undefined,
      type: body.type as RewardType,
      requiredPoints: body.requiredPoints,
      stock: typeof body.stock === "number" ? body.stock : null,
      limitPerMember: typeof body.limitPerMember === "number" ? body.limitPerMember : null,
      branchScope: Array.isArray(body.branchScope) ? (body.branchScope as string[]) : undefined,
      voucherExpiryRule: parseVoucherExpiryRule(body.voucherExpiryRule),
      startAt: parseOptionalDate(body.startAt, "startAt") ?? null,
      endAt: parseOptionalDate(body.endAt, "endAt") ?? null,
    });

    return NextResponse.json({ rewardId }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
