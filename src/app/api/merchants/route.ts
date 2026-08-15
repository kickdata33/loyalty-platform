import { NextResponse } from "next/server";

import { verifyBearerToken } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { createMerchantWithOwner } from "@/modules/merchant/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/**
 * POST /api/merchants — Owner onboarding (§33 Phase 2, §8 bootstrap exception).
 *
 * The one protected route that does NOT call `requireStaffAuthContext()` — a brand-new,
 * just-signed-up user has no StaffUser/custom claims yet, so there is nothing to resolve into an
 * `AuthContext`. It still verifies the Bearer token (`verifyBearerToken`) and uses ONLY the
 * verified `uid` from that token as the new merchant's owner — never a client-supplied uid.
 */

interface OnboardingRequestBody {
  name?: unknown;
  slug?: unknown;
  businessType?: unknown;
  timezone?: unknown;
}

export async function POST(request: Request) {
  try {
    const decoded = await verifyBearerToken(request);
    const body = (await request.json().catch(() => ({}))) as OnboardingRequestBody;

    if (
      typeof body.name !== "string" ||
      typeof body.slug !== "string" ||
      typeof body.businessType !== "string" ||
      typeof body.timezone !== "string"
    ) {
      throw new ValidationError(
        "name, slug, businessType, and timezone are all required strings.",
      );
    }

    // ownerAuthUid always comes from the verified token — any uid/ownerAuthUid field in the
    // request body is simply never read.
    const result = await createMerchantWithOwner({
      name: body.name,
      slug: body.slug,
      businessType: body.businessType,
      timezone: body.timezone,
      ownerAuthUid: decoded.uid,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
