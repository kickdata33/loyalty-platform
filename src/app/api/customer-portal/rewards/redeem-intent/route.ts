import { NextResponse } from "next/server";

import { resolveVerifiedLineCustomer } from "@/modules/customer-portal/auth";
import { findMembershipByPlatformCustomer } from "@/modules/membership/service";
import { createRedemptionIntent } from "@/modules/reward/redemption-intent";
import { toApiErrorResponse } from "@/lib/api/errors";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/**
 * Customer self-service reward redemption — step 1 of 2 (§ new work). Same identity-verification
 * sequence as every other customer-portal endpoint (`resolveVerifiedLineCustomer`) — the client
 * sends only `{ merchantSlug, idToken, rewardTemplateId }`, never a membershipId/points/balance
 * value. Creates a short-lived, one-time PENDING redemption intent; does NOT deduct any points —
 * that only ever happens when staff scans and confirms (`confirmRedemptionIntent`).
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      merchantSlug?: unknown;
      idToken?: unknown;
      rewardTemplateId?: unknown;
    };
    if (typeof body.merchantSlug !== "string" || body.merchantSlug.trim().length === 0) {
      throw new ValidationError("merchantSlug is required.");
    }
    if (typeof body.idToken !== "string" || body.idToken.trim().length === 0) {
      throw new ValidationError("idToken is required.");
    }
    if (typeof body.rewardTemplateId !== "string" || body.rewardTemplateId.trim().length === 0) {
      throw new ValidationError("rewardTemplateId is required.");
    }

    const { merchant, platformCustomerId } = await resolveVerifiedLineCustomer(body.merchantSlug, body.idToken);
    const membership = await findMembershipByPlatformCustomer(merchant.merchantId, platformCustomerId);
    if (!membership) throw new NotFoundError("No membership found for this account yet.");

    const result = await createRedemptionIntent(merchant.merchantId, membership.id, body.rewardTemplateId);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
