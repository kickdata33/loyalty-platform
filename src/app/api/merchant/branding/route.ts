import { NextResponse } from "next/server";

import { requireStaffAuthContext } from "@/lib/api/auth";
import { toApiErrorResponse } from "@/lib/api/errors";
import { updateMerchantBranding } from "@/modules/merchant/service";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

interface BrandingRequestBody {
  logoUrl?: unknown;
  coverUrl?: unknown;
  primaryColor?: unknown;
}

/** PATCH /api/merchant/branding — updates the caller's own merchant's branding config
 * (BRANDING_MANAGE — Owner/Manager only, enforced inside `updateMerchantBranding`). */
export async function PATCH(request: Request) {
  try {
    const ctx = await requireStaffAuthContext(request);
    const body = (await request.json().catch(() => ({}))) as BrandingRequestBody;

    const branding: { logoUrl?: string; coverUrl?: string; primaryColor?: string } = {};
    for (const [key, value] of Object.entries(body)) {
      // Empty string ("" from an untouched optional form field) means "not set" — omit it rather
      // than pass it through to be rejected by updateMerchantBranding's URL/color format check.
      if (value === undefined || value === "") continue;
      if (typeof value !== "string") {
        throw new ValidationError(`${key} must be a string.`);
      }
      if (key === "logoUrl" || key === "coverUrl" || key === "primaryColor") {
        branding[key] = value;
      }
    }

    // merchantId always ctx.merchantId — the client never specifies which merchant to update.
    await updateMerchantBranding(ctx, ctx.merchantId, branding);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
