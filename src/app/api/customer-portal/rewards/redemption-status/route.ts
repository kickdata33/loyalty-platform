import { NextResponse } from "next/server";

import { resolveVerifiedLineCustomer } from "@/modules/customer-portal/auth";
import { findMembershipByPlatformCustomer } from "@/modules/membership/service";
import { getRedemptionIntentStatusForCustomer } from "@/modules/reward/redemption-intent";
import { toApiErrorResponse } from "@/lib/api/errors";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/**
 * Customer self-service reward redemption — status poll, so the member portal can tell when staff
 * has confirmed the redemption without requiring a manual page reload. Read-only.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      merchantSlug?: unknown;
      idToken?: unknown;
      intentId?: unknown;
    };
    if (typeof body.merchantSlug !== "string" || body.merchantSlug.trim().length === 0) {
      throw new ValidationError("merchantSlug is required.");
    }
    if (typeof body.idToken !== "string" || body.idToken.trim().length === 0) {
      throw new ValidationError("idToken is required.");
    }
    if (typeof body.intentId !== "string" || body.intentId.trim().length === 0) {
      throw new ValidationError("intentId is required.");
    }

    const { merchant, platformCustomerId } = await resolveVerifiedLineCustomer(body.merchantSlug, body.idToken);
    const membership = await findMembershipByPlatformCustomer(merchant.merchantId, platformCustomerId);
    if (!membership) throw new NotFoundError("No membership found for this account yet.");

    const result = await getRedemptionIntentStatusForCustomer(merchant.merchantId, membership.id, body.intentId);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
