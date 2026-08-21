import "server-only";

import { verifyLineIdToken } from "@/modules/line-integration/id-token-verification";
import { loadLineChannelConfigInternal } from "@/modules/line-channel/service";
import { resolveOrCreatePlatformCustomer } from "@/modules/identity/service";
import { getPublicMerchantProfileBySlug, type PublicMerchantProfile } from "@/modules/merchant/service";
import { ValidationError } from "@/modules/shared/errors";

/**
 * The one place that verifies a customer's LINE identity server-side (§21) — extracted from
 * `/api/customer-portal/line-login` so the new customer-portal read endpoint reuses the exact
 * same verification sequence instead of duplicating it (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่").
 * `merchantId` is resolved server-side from `merchantSlug` (never accepted directly), and used to
 * load the expected Login Channel ID that `verifyLineIdToken` checks the token's `aud` against —
 * closing the cross-tenant token-replay path named in §26. The caller sends ONLY `{ idToken }`
 * (§22) — never a userId/profile field, per §21's untrusted-client-input rule.
 */
export interface VerifiedLineCustomer {
  merchant: PublicMerchantProfile;
  platformCustomerId: string;
  /** Verified `sub` from `verifyLineIdToken` ONLY — never a raw client-supplied value (§21). */
  lineUserId: string;
  channelId: string;
}

export async function resolveVerifiedLineCustomer(
  merchantSlug: string,
  idToken: string,
): Promise<VerifiedLineCustomer> {
  const merchant = await getPublicMerchantProfileBySlug(merchantSlug);
  if (!merchant) throw new ValidationError("Unknown merchant.");

  const config = await loadLineChannelConfigInternal(merchant.merchantId);
  const verified = await verifyLineIdToken(idToken, config.loginChannel.channelId);

  const platformCustomerId = await resolveOrCreatePlatformCustomer({
    provider: "line",
    providerScope: config.lineProviderId,
    subject: verified.sub,
    verified: true,
  });

  return {
    merchant,
    platformCustomerId,
    lineUserId: verified.sub,
    channelId: config.loginChannel.channelId,
  };
}
