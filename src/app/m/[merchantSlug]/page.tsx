import { notFound } from "next/navigation";

import { LineClientProviderRoot } from "@/components/customer-portal/LineClientProviderContext";
import { LineLoginButton } from "@/components/customer-portal/LineLoginButton";
import { getPublicMerchantProfileBySlug } from "@/modules/merchant/service";

/**
 * Customer Portal (FINAL-ARCHITECTURE.md §33 Phase 2 skeleton, real LINE login wired in Phase 7).
 * Server Component — calls the service layer directly (no HTTP round-trip needed for a Server
 * Component) via the one deliberately-public read in the merchant module.
 *
 * The LINE button routes through `LineClientProviderRoot`/`useLineClient()` (§22) — real
 * `LiffClientProvider` once `merchant.liffId` exists (merchant has connected LINE, §19/§20),
 * honest "not available yet" `NotImplementedLineClientProvider` otherwise. Points/rewards/coupons
 * display for a logged-in member remain out of this page's scope (not named in §33's Phase 7 DoD
 * text — deferred, same as Phase 2).
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
        <p className="text-sm text-slate-600">บัตรสมาชิกและสิทธิประโยชน์ — เร็วๆ นี้</p>
        <LineLoginButton merchantSlug={merchantSlug} />
      </main>
    </LineClientProviderRoot>
  );
}
