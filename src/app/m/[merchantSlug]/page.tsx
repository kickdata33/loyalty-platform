import { notFound } from "next/navigation";

import { LineClientProviderRoot } from "@/components/customer-portal/LineClientProviderContext";
import { LineLoginButton } from "@/components/customer-portal/LineLoginButton";
import { getPublicMerchantProfileBySlug } from "@/modules/merchant/service";

/**
 * Customer Portal (FINAL-ARCHITECTURE.md §33 Phase 2 skeleton, real LINE login wired in Phase 7;
 * member card/QR/points/rewards/coupons view approved as new work beyond Phase 7's original DoD).
 * Server Component — calls the service layer directly (no HTTP round-trip needed for a Server
 * Component) via the one deliberately-public read in the merchant module.
 *
 * The LINE button routes through `LineClientProviderRoot`/`useLineClient()` (§22) — real
 * `LiffClientProvider` once `merchant.liffId` exists (merchant has connected LINE, §19/§20),
 * honest "not available yet" `NotImplementedLineClientProvider` otherwise. `LineLoginButton`
 * itself renders the authenticated member's portal view once logged in — this page has no
 * pre-login placeholder copy to keep in sync with that state.
 */
export default async function CustomerPortalPage({
  params,
}: {
  params: Promise<{ merchantSlug: string }>;
}) {
  const { merchantSlug } = await params;
  const merchant = await getPublicMerchantProfileBySlug(merchantSlug);
  if (!merchant) notFound();

  return (
    <LineClientProviderRoot liffId={merchant.liffId}>
      <main
        className="flex min-h-full flex-1 flex-col items-center justify-center gap-6 p-6 text-center"
        style={merchant.branding.primaryColor ? { color: merchant.branding.primaryColor } : undefined}
      >
        {merchant.branding.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- merchant-supplied URL, not a static asset
          <img src={merchant.branding.logoUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
        ) : null}
        <h1 className="text-2xl font-semibold">{merchant.name}</h1>
        <LineLoginButton merchantSlug={merchantSlug} />
      </main>
    </LineClientProviderRoot>
  );
}
