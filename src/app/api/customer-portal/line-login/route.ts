import { NextResponse } from "next/server";

import { resolveVerifiedLineCustomer } from "@/modules/customer-portal/auth";
import { resolveOrCreateLineMembership } from "@/modules/membership/service";
import { toApiErrorResponse } from "@/lib/api/errors";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/**
 * Customer-side LINE login (§20 "Customer-side" flow, §21). No staff `AuthContext` — this is a
 * customer self-service endpoint. Identity verification is delegated to
 * `resolveVerifiedLineCustomer` (shared with the customer-portal read endpoint).
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { merchantSlug?: unknown; idToken?: unknown; displayName?: unknown };
    if (typeof body.merchantSlug !== "string" || body.merchantSlug.trim().length === 0) {
      throw new ValidationError("merchantSlug is required.");
    }
    if (typeof body.idToken !== "string" || body.idToken.trim().length === 0) {
      throw new ValidationError("idToken is required.");
    }

    const { merchant, platformCustomerId, lineUserId, channelId } = await resolveVerifiedLineCustomer(
      body.merchantSlug,
      body.idToken,
    );

    // Cosmetic only (§21) — never part of identity/authorization above (platformCustomerId/
    // membershipId resolution is already complete and depends solely on verified.sub). A missing
    // or empty displayName here means "no cosmetic name provided this time", not "named สมาชิก" —
    // resolveOrCreateLineMembership() decides the actual fallback/update behavior from that.
    const trimmedDisplayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const displayName = trimmedDisplayName.length > 0 ? trimmedDisplayName : null;

    const membershipId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId,
      lineUserId,
      channelId,
      displayName,
    });

    return NextResponse.json({ membershipId }, { status: 200 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
