import { notFound } from "next/navigation";

import { LineClientProviderRoot } from "@/components/customer-portal/LineClientProviderContext";
import { LineLoginButton } from "@/components/customer-portal/LineLoginButton";
import { getPublicMerchantProfileBySlug } from "@/modules/merchant/service";

/**
 * Customer Portal skeleton (FINAL-ARCHITECTURE.md §33 Phase 2: "Customer Portal skeleton
 * ยังไม่มี points"). Server Component — calls the service layer directly (no HTTP round-trip
 * needed for a Server Component) via the one deliberately-public read in the merchant module.
 *
 * No points/rewards/coupons, no real LINE login (Phase 7) — the LINE button below routes through
 * `LineClientProviderRoot`/`useLineClient()` (§22) and honestly reports "not available yet"
 * instead of faking a login.
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
    <LineClientProviderRoot>
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
        <LineLoginButton />
      </main>
    </LineClientProviderRoot>
  );
}
