import { NextResponse } from "next/server";

import { verifyLineIdToken } from "@/modules/line-integration/id-token-verification";
import { loadLineChannelConfigInternal } from "@/modules/line-channel/service";
import { resolveOrCreateLineMembership } from "@/modules/membership/service";
import { resolveOrCreatePlatformCustomer } from "@/modules/identity/service";
import { getPublicMerchantProfileBySlug } from "@/modules/merchant/service";
import { toApiErrorResponse } from "@/lib/api/errors";
import { ValidationError } from "@/modules/shared/errors";

export const runtime = "nodejs";

/**
 * Customer-side LINE login (§20 "Customer-side" flow, §21). No staff `AuthContext` — this is a
 * customer self-service endpoint. `merchantId` is resolved server-side from `merchantSlug`
 * (never accepted directly from the request body) and used to load the expected Login Channel ID
 * that `verifyLineIdToken` checks the token's `aud` against — closing the cross-tenant token-
 * replay path named in §26. The client sends ONLY `{ idToken }` (§22) — never a userId/profile
 * field, per §21's untrusted-client-input rule.
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

    const merchant = await getPublicMerchantProfileBySlug(body.merchantSlug);
    if (!merchant) throw new ValidationError("Unknown merchant.");

    const config = await loadLineChannelConfigInternal(merchant.merchantId);
    const verified = await verifyLineIdToken(body.idToken, config.loginChannel.channelId);

    const platformCustomerId = await resolveOrCreatePlatformCustomer({
      provider: "line",
      providerScope: config.lineProviderId,
      subject: verified.sub,
      verified: true,
    });

    const membershipId = await resolveOrCreateLineMembership({
      merchantId: merchant.merchantId,
      platformCustomerId,
      lineUserId: verified.sub,
      channelId: config.loginChannel.channelId,
      displayName: typeof body.displayName === "string" ? body.displayName : "สมาชิก",
    });

    return NextResponse.json({ membershipId }, { status: 200 });
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
