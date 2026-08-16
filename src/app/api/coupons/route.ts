import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { createCouponTemplate, listCouponTemplates } from "@/modules/coupon/service";
import type { CouponExpiryRule, CouponType } from "@/modules/coupon/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const coupons = await listCouponTemplates(ctx);
    return NextResponse.json(coupons);
  } catch (error) {
    return toApiErrorResponse(error);
  }
}

interface CreateCouponBody {
  name?: unknown;
  description?: unknown;
  type?: unknown;
  minimumAmount?: unknown;
  maximumDiscount?: unknown;
  validDaysOfWeek?: unknown;
  validTimeRange?: unknown;
  branchScope?: unknown;
  totalLimit?: unknown;
  limitPerMember?: unknown;
  startAt?: unknown;
  endAt?: unknown;
  expiryRule?: unknown;
  stackable?: unknown;
}

const VALID_TYPES = [
  "PERCENTAGE_DISCOUNT",
  "FIXED_DISCOUNT",
  "FREE_PRODUCT",
  "FREE_SERVICE",
  "BUY_X_GET_Y",
  "PRIVILEGE",
  "CUSTOM",
];

function parseExpiryRule(value: unknown): CouponExpiryRule | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { type?: unknown; days?: unknown };
  if (v.type === "NEVER") return { type: "NEVER" };
  if (v.type === "DAYS_AFTER_ISSUANCE" && typeof v.days === "number") {
    return { type: "DAYS_AFTER_ISSUANCE", days: v.days };
  }
  // FIXED_DATE requires a real Firestore Timestamp, not constructible from a plain request body
  // field — reject rather than silently falling back (same posture as rewards' route).
  throw new ValidationError("expiryRule must be NEVER or DAYS_AFTER_ISSUANCE (with a positive `days`).");
}

function parseOptionalDate(value: unknown, fieldName: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ValidationError(`${fieldName} must be an ISO date string.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${fieldName} must be a valid date.`);
  return date;
}

function parseTimeRange(value: unknown): { start: string; end: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { start?: unknown; end?: unknown };
  if (typeof v.start !== "string" || typeof v.end !== "string") {
    throw new ValidationError("validTimeRange must have string `start`/`end` in HH:mm format.");
  }
  return { start: v.start, end: v.end };
}

export async function POST(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as CreateCouponBody;

    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      throw new ValidationError("name is required.");
    }
    if (typeof body.type !== "string" || !VALID_TYPES.includes(body.type)) {
      throw new ValidationError(`type must be one of ${VALID_TYPES.join(", ")}.`);
    }

    const couponId = await createCouponTemplate(ctx, {
      name: body.name,
      description: typeof body.description === "string" ? body.description : undefined,
      type: body.type as CouponType,
      minimumAmount: typeof body.minimumAmount === "number" ? body.minimumAmount : null,
      maximumDiscount: typeof body.maximumDiscount === "number" ? body.maximumDiscount : null,
      validDaysOfWeek: Array.isArray(body.validDaysOfWeek) ? (body.validDaysOfWeek as number[]) : undefined,
      validTimeRange: parseTimeRange(body.validTimeRange) ?? null,
      branchScope: Array.isArray(body.branchScope) ? (body.branchScope as string[]) : undefined,
      totalLimit: typeof body.totalLimit === "number" ? body.totalLimit : null,
      limitPerMember: typeof body.limitPerMember === "number" ? body.limitPerMember : null,
      startAt: parseOptionalDate(body.startAt, "startAt") ?? null,
      endAt: parseOptionalDate(body.endAt, "endAt") ?? null,
      expiryRule: parseExpiryRule(body.expiryRule),
      stackable: typeof body.stackable === "boolean" ? body.stackable : undefined,
    });

    return NextResponse.json({ couponId }, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
