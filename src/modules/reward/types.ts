import type { Timestamp } from "firebase-admin/firestore";

/**
 * Reward Template / Voucher Instance (FINAL-ARCHITECTURE.md §4, §5, §13) — the Template→Instance
 * pattern used across the codebase (Reward Template → Voucher Instance, mirroring Points Rules in
 * Phase 3): a Template is "the rule", an Instance is "what actually happened to one member".
 */

/** §13: "Reward types: Fixed Discount, Percentage Discount, Free Product, Free Service,
 * Privilege, Physical Reward, Custom Reward". */
export type RewardType =
  | "FIXED_DISCOUNT"
  | "PERCENTAGE_DISCOUNT"
  | "FREE_PRODUCT"
  | "FREE_SERVICE"
  | "PRIVILEGE"
  | "PHYSICAL_REWARD"
  | "CUSTOM";

/**
 * `rewardTemplates/{rewardId}.voucherExpiryRule` — §13 "Voucher Expiration" as a configurable
 * template field. Deliberately NOT offering a `SEASON_BASED` option here the way
 * `PointsExpirationPolicy` (Phase 3) had to explicitly reject one: §13 never mentions "season" for
 * voucher expiry at all (unlike §12 for points), so there is no rejected-but-scaffolded case to
 * carry — only the two forms the architecture actually describes are modeled.
 */
export type VoucherExpiryRule =
  | { type: "NEVER" }
  | { type: "DAYS_AFTER_REDEMPTION"; days: number }
  | { type: "FIXED_DATE"; date: Timestamp };

/**
 * `rewardTemplates/{rewardId}` — §5's compact schema list doesn't spell out `name`/`type`/
 * `enabled`/`description` explicitly (unlike `staffLimits`, which IS spelled out field-by-field);
 * §13's fuller prose does ("Reward types: ...", "กำหnดได้: Required Points, Total/Unlimited
 * Stock, Limit per Member, Start/End Date, Voucher Expiration, Allowed Branches") — this shape
 * fills that documented-but-unspecified-exact-shape gap the same way Phase 2/3 filled
 * `BrandingConfig`/`PointsExpirationPolicy`, not a new business rule.
 */
export interface RewardTemplate {
  id: string;
  merchantId: string;
  name: string;
  description: string;
  type: RewardType;
  enabled: boolean;
  requiredPoints: number;
  /** `null` = unlimited stock (§13). */
  stock: number | null;
  /** `null` = unlimited per member (§13). */
  limitPerMember: number | null;
  /** Empty = all branches (§13 "Allowed Branches"), same convention as `pointRules.branchScope`
   * (§11) and `automations` — never re-invented per collection. */
  branchScope: string[];
  startAt: Timestamp | null;
  endAt: Timestamp | null;
  voucherExpiryRule: VoucherExpiryRule;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type VoucherStatus = "AVAILABLE" | "USED" | "EXPIRED";

/**
 * `voucherInstances/{voucherId}` — §5, §13. `sourceLedgerEntryId` is not in §5's compact list but
 * is required to implement the locked Open Decision from Phase 4 Planning Review: Use-time
 * validation must be able to check whether the `pointsLedger` SPEND entry that paid for this
 * voucher has since been reversed (`reversedBy` set) — entirely via a one-directional
 * reward→points read, never by adding reward-awareness into `points/ledger-service.ts`.
 */
export interface VoucherInstance {
  id: string;
  merchantId: string;
  membershipId: string;
  rewardTemplateId: string;
  status: VoucherStatus;
  sourceLedgerEntryId: string;
  redeemedAt: Timestamp;
  expiresAt: Timestamp | null;
  usedAt: Timestamp | null;
  usedByStaffId: string | null;
  usedBranchId: string | null;
}
