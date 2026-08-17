import { Timestamp } from "firebase-admin/firestore";
import { NextResponse } from "next/server";

import { requireSuperAdminAuthContext } from "@/lib/api/super-admin-auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { setMerchantSubscription } from "@/modules/billing-entitlement/service";
import type { SubscriptionStatus } from "@/modules/billing-entitlement/types";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

const VALID_STATUSES: readonly SubscriptionStatus[] = [
  "TRIAL",
  "ACTIVE",
  "PAST_DUE",
  "GRACE",
  "SUSPENDED",
  "CANCELLED",
];

interface SetSubscriptionRequestBody {
  packageId?: unknown;
  status?: unknown;
  trialEndsAt?: unknown;
  currentPeriodEnd?: unknown;
  reason?: unknown;
}

function parseTimestamp(value: unknown, field: string): Timestamp | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be an ISO date string or null.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ValidationError(`${field} is not a valid date.`);
  return Timestamp.fromDate(date);
}

/** Manual subscription change — Super Admin only (§25 "V1 ไม่มี Automatic Subscription Billing",
 * §37). This IS the entire billing-status-change surface for V1. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ merchantId: string }> },
) {
  try {
    const admin = await requireSuperAdminAuthContext(request);
    const { merchantId } = await params;
    const body = (await request.json().catch(() => ({}))) as SetSubscriptionRequestBody;

    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      throw new ValidationError("reason is required.");
    }
    if (body.status !== undefined && !VALID_STATUSES.includes(body.status as SubscriptionStatus)) {
      throw new ValidationError(`status must be one of: ${VALID_STATUSES.join(", ")}`);
    }
    if (body.packageId !== undefined && body.packageId !== null && typeof body.packageId !== "string") {
      throw new ValidationError("packageId must be a string or null.");
    }

    await setMerchantSubscription(admin, merchantId, {
      packageId: body.packageId as string | null | undefined,
      status: body.status as SubscriptionStatus | undefined,
      trialEndsAt: parseTimestamp(body.trialEndsAt, "trialEndsAt"),
      currentPeriodEnd: parseTimestamp(body.currentPeriodEnd, "currentPeriodEnd"),
      reason: body.reason,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
