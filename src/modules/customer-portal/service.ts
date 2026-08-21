import "server-only";

import { generateMemberQrCodeDataUrl } from "@/modules/points/qr";
import { listPointsLedgerForMembership } from "@/modules/points/ledger-service";
import { findMembershipByPlatformCustomer } from "@/modules/membership/service";
import { listRewardTemplatesForMerchant, listVoucherInstancesForMembership } from "@/modules/reward/service";
import { listCouponInstancesForMembership } from "@/modules/coupon/service";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { Timestamp } from "firebase-admin/firestore";

/**
 * Authenticated customer's own portal view (§33 — member card/QR/points/rewards/coupons; scope
 * beyond Phase 7's original DoD, approved as new work). Every list here is scoped to ONE
 * membership already resolved from the customer's own verified identity
 * (`findMembershipByPlatformCustomer`, keyed on `(merchantId, platformCustomerId)`) — never a
 * client-supplied `membershipId`, so tenant isolation and "only your own data" both fall out of
 * the same identity-resolution step every other customer-portal endpoint already uses. Reuses the
 * exact same query functions the staff-facing history endpoints call
 * (`listVoucherInstancesForMembership`/`listCouponInstancesForMembership`/
 * `listPointsLedgerForMembership`) — no parallel data path.
 *
 * Every field here is display-only: no `platformCustomerId`, `merchantLineIdentity`/`lineUserId`,
 * `merchantId`, or any other identity/internal field is ever included in the returned shape.
 */

export interface CustomerPortalRewardItem {
  id: string;
  rewardName: string;
  status: "AVAILABLE" | "USED" | "EXPIRED";
  redeemedAt: string;
  usedAt: string | null;
}

export interface CustomerPortalCouponItem {
  id: string;
  couponName: string;
  status: "AVAILABLE" | "USED" | "EXPIRED";
  issuedAt: string;
  usedAt: string | null;
}

export interface CustomerPortalPointsHistoryItem {
  id: string;
  type: string;
  delta: number;
  reason: string;
  createdAt: string;
}

export interface CustomerPortalAvailableReward {
  id: string;
  name: string;
  description: string;
  requiredPoints: number;
  /** Informational only — pointsBalance >= requiredPoints at view time. The actual, authoritative
   * check happens fresh at redemption-confirm time (`redeemReward()`), not here. */
  eligible: boolean;
}

export interface CustomerPortalView {
  displayName: string;
  memberCode: string;
  pointsBalance: number;
  qrCodeDataUrl: string;
  joinedAt: string;
  availableRewards: CustomerPortalAvailableReward[];
  rewards: CustomerPortalRewardItem[];
  coupons: CustomerPortalCouponItem[];
  pointsHistory: CustomerPortalPointsHistoryItem[];
}

const POINTS_HISTORY_LIMIT = 20;

/** Batch-resolves template names for display — the only genuinely new query here (no existing
 * function returns "name for this template id" in bulk); everything else above is reused as-is. */
async function resolveTemplateNames(collection: string, ids: readonly string[]): Promise<Map<string, string>> {
  const uniqueIds = [...new Set(ids)];
  const names = new Map<string, string>();
  await Promise.all(
    uniqueIds.map(async (id) => {
      const snap = await getDb().collection(collection).doc(id).get();
      const name = snap.exists ? (snap.data() as { name?: string }).name : undefined;
      if (name) names.set(id, name);
    }),
  );
  return names;
}

function toIso(ts: Timestamp | null | undefined): string | null {
  return ts ? ts.toDate().toISOString() : null;
}

/** `null` if this customer has no membership at all for this merchant yet — shouldn't happen in
 * practice (login always resolves-or-creates one first) but handled honestly rather than assumed. */
export async function getCustomerPortalView(
  merchantId: string,
  platformCustomerId: string,
): Promise<CustomerPortalView | null> {
  const membership = await findMembershipByPlatformCustomer(merchantId, platformCustomerId);
  if (!membership) return null;

  const [qrCodeDataUrl, vouchers, coupons, ledgerEntries, rewardTemplates] = await Promise.all([
    generateMemberQrCodeDataUrl(membership.memberCode),
    listVoucherInstancesForMembership(merchantId, membership.id),
    listCouponInstancesForMembership(merchantId, membership.id),
    listPointsLedgerForMembership(merchantId, membership.id),
    listRewardTemplatesForMerchant(merchantId),
  ]);

  const [rewardNames, couponNames] = await Promise.all([
    resolveTemplateNames(
      COLLECTIONS.rewardTemplates,
      vouchers.map((v) => v.rewardTemplateId),
    ),
    resolveTemplateNames(
      COLLECTIONS.couponTemplates,
      coupons.map((c) => c.couponTemplateId),
    ),
  ]);

  const now = new Date();
  const availableRewards = rewardTemplates
    .filter((t) => t.enabled)
    .filter((t) => !t.startAt || t.startAt.toDate() <= now)
    .filter((t) => !t.endAt || t.endAt.toDate() >= now)
    .filter((t) => t.stock === null || t.stock > 0)
    .map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      requiredPoints: t.requiredPoints,
      eligible: membership.pointsBalance >= t.requiredPoints,
    }));

  return {
    displayName: membership.merchantProfile.displayName,
    memberCode: membership.memberCode,
    pointsBalance: membership.pointsBalance,
    qrCodeDataUrl,
    joinedAt: membership.joinedAt.toDate().toISOString(),
    availableRewards,
    rewards: vouchers.map((v) => ({
      id: v.id,
      rewardName: rewardNames.get(v.rewardTemplateId) ?? "รางวัล",
      status: v.status,
      redeemedAt: v.redeemedAt.toDate().toISOString(),
      usedAt: toIso(v.usedAt),
    })),
    coupons: coupons.map((c) => ({
      id: c.id,
      couponName: couponNames.get(c.couponTemplateId) ?? "คูปอง",
      status: c.status,
      issuedAt: c.issuedAt.toDate().toISOString(),
      usedAt: toIso(c.usedAt),
    })),
    pointsHistory: ledgerEntries.slice(0, POINTS_HISTORY_LIMIT).map((e) => ({
      id: e.id,
      type: typeof e.type === "string" ? e.type : "UNKNOWN",
      delta: typeof e.delta === "number" ? e.delta : 0,
      reason: typeof e.reason === "string" ? e.reason : "",
      createdAt: toIso(e.createdAt as Timestamp | undefined) ?? "",
    })),
  };
}
