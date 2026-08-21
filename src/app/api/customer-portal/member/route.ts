import { NextResponse } from "next/server";

import { resolveVerifiedLineCustomer } from "@/modules/customer-portal/auth";
import { getCustomerPortalView } from "@/modules/customer-portal/service";
import { toApiErrorResponse } from "@/lib/api/errors";
import { ValidationError, NotFoundError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/**
 * Authenticated customer's own portal view — member card, QR, points, rewards, coupons, recent
 * activity. Same identity-verification sequence as `/api/customer-portal/line-login`
 * (`resolveVerifiedLineCustomer`, shared, not duplicated) — read-only, never creates/modifies a
 * membership. The client sends ONLY `{ merchantSlug, idToken }` (§21/§22) — there is no
 * `membershipId` parameter anywhere in this request; which membership to return is derived
 * entirely from the verified identity server-side, so this can never be used to view another
 * customer's data.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { merchantSlug?: unknown; idToken?: unknown };
    if (typeof body.merchantSlug !== "string" || body.merchantSlug.trim().length === 0) {
      throw new ValidationError("merchantSlug is required.");
    }
    if (typeof body.idToken !== "string" || body.idToken.trim().length === 0) {
      throw new ValidationError("idToken is required.");
    }

    const { merchant, platformCustomerId } = await resolveVerifiedLineCustomer(body.merchantSlug, body.idToken);

    const view = await getCustomerPortalView(merchant.merchantId, platformCustomerId);
    if (!view) throw new NotFoundError("No membership found for this account yet.");

    return NextResponse.json(view, { status: 200 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
