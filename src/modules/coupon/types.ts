import type { Timestamp } from "firebase-admin/firestore";

/**
 * Coupon Template / Coupon Instance (FINAL-ARCHITECTURE.md §4, §5, §14) — same Template→Instance
 * pattern as Reward (Phase 4), but Coupon **never touches the points ledger**: `couponInstances`
 * has no `sourceLedgerEntryId`-equivalent field anywhere in §5's schema, and §14 says outright
 * "ไม่ต้องแลกด้วยแต้มเสมอไป" (doesn't require spending points). `issueCoupon*` therefore never
 * imports from `points/ledger-service.ts` at all.
 *
 * Terminology warning carried over from the Phase 5 Planning Review — do NOT confuse with Reward:
 * - Reward: Redeem = FIRST step (spend points → get voucher); Use = SECOND step (consume it).
 * - Coupon: **Issue** = FIRST step (get the coupon, no points spent); **Redeem** = SECOND step
 *   (consume it at the counter) — confirmed by §17's event list (`coupon.issued`, `coupon.redeemed`,
 *   no `coupon.used`) and by `COUPON_REDEEM` in the LOCKED Permission Matrix (§9) meaning the
 *   consume step, same as how "redeem a coupon" is normally used in retail.
 */

/** §14: "Coupon Types: Percentage Discount, Fixed Discount, Free Product, Free Service, Buy X Get
 * Y, Privilege, Custom". */
export type CouponType =
  | "PERCENTAGE_DISCOUNT"
  | "FIXED_DISCOUNT"
  | "FREE_PRODUCT"
  | "FREE_SERVICE"
  | "BUY_X_GET_Y"
  | "PRIVILEGE"
  | "CUSTOM";

/** §14 Distribution: "Manual, Segment, Promotion, Birthday, New Member, Inactive Customer, Points
 * Milestone, Campaign, Coupon Code, QR Campaign — บางประเภทอยู่ V2 ได้ แต่ data model ต้องรองรับ
 * ตั้งแต่ต้น". Phase 5 (§33: "Distribution (manual/segment ก่อน)") only ever produces MANUAL and
 * SEGMENT — the other 8 values are modeled here (so `issuedVia` never needs a breaking schema
 * change later) but have no producer in this codebase yet. See the Phase 5 Planning Review for why
 * each of the other 8 is blocked on infrastructure this repo doesn't have (Automation Engine,
 * segment recalculation job, customer self-service auth, ...). */
export type CouponIssuedVia =
  | "MANUAL"
  | "SEGMENT"
  | "PROMOTION"
  | "BIRTHDAY"
  | "NEW_MEMBER"
  | "INACTIVE_CUSTOMER"
  | "POINTS_MILESTONE"
  | "CAMPAIGN"
  | "COUPON_CODE"
  | "QR_CAMPAIGN";

/**
 * §14 "Expire X days after issued" — deliberately mirrors Reward's `VoucherExpiryRule` shape
 * (§13) but renamed `DAYS_AFTER_ISSUANCE` to match Coupon's own terminology (issued, not
 * redeemed) — same "NEVER never needs a rejected SEASON_BASED case" reasoning as Reward: §14
 * never mentions "season" for coupons either.
 */
export type CouponExpiryRule =
  | { type: "NEVER" }
  | { type: "DAYS_AFTER_ISSUANCE"; days: number }
  | { type: "FIXED_DATE"; date: Timestamp };

/**
 * §14 "Conditions รองรับ: Minimum Amount, Maximum Discount, Valid Days/Hours, Branch, Usage
 * Limit, Total Limit, Per Member Limit, Start/End, Expire X days after issued, Stackable/
 * Non-stackable" — §5 groups all of these under a single `conditions{}` field on the template
 * (unlike Reward, whose §5 entry has no such wrapper and lists its fields flat) — this interface
 * follows that grouping literally rather than flattening it onto the template root the way Reward
 * was built, to stay faithful to each domain's own documented shape independently.
 *
 * - `totalLimit`/`limitPerMember`: checked at ISSUANCE time (gates "can a new instance be
 *   created at all") — direct counterparts of Reward's `stock`/`limitPerMember`. Per the locked
 *   Phase 5 "Usage Limit" decision, "Usage Limit" in §14's list is this same concept, not a
 *   separate per-instance multi-use counter — `couponInstances.status` (§5) is a one-way
 *   `AVAILABLE→USED` enum with no field for "remaining uses", so no such counter is modeled here.
 * - `branchScope`/`validDaysOfWeek`/`validTimeRange`: checked at REDEMPTION time (gates "can THIS
 *   already-issued instance be used right now, right here") — §14's Redemption Flow explicitly
 *   validates "branch" as part of the Staff-scan step, not issuance.
 * - `minimumAmount`/`maximumDiscount`/`stackable`: §14 — "เก็บเป็น metadata ให้ staff อ่านและ
 *   ยืนยันด้วยสายตา — ระบบไม่ enforce เชิงตัวเลขจริงจนกว่าจะมี POS integration (นอก scope V1)" —
 *   never validated by any service function in this module, only surfaced to the redeem UI.
 */
export interface CouponConditions {
  /** `null` = not set (Firestore has no `undefined` — every optional field here is nullable, not
   * optional, so a document round-trips through Firestore with no ambiguity). */
  minimumAmount: number | null;
  maximumDiscount: number | null;
  /** 0=Sunday..6=Saturday, empty = every day (mirrors PointRule MULTIPLIER's `dayOfWeek`, §11 —
   * same shape, not reinvented). */
  validDaysOfWeek: number[];
  /** "HH:mm" 24h, `null` = all hours (mirrors PointRule MULTIPLIER's `timeRange`, §11). */
  validTimeRange: { start: string; end: string } | null;
  /** Empty = all branches (§14 "Branch"; same convention as `pointRules.branchScope`/
   * `rewardTemplates.branchScope`, never re-invented per collection). */
  branchScope: string[];
  /** null = unlimited (§14 "Total Limit" / "Usage Limit" per the locked V1 decision). */
  totalLimit: number | null;
  /** null = unlimited (§14 "Per Member Limit"). */
  limitPerMember: number | null;
  startAt: Timestamp | null;
  endAt: Timestamp | null;
  expiryRule: CouponExpiryRule;
  stackable: boolean;
}

/** `couponTemplates/{couponId}` (§5). `name`/`description`/`enabled` are not spelled out in §5's
 * compact schema line (just like Reward's — same documented-but-unspecified-shape gap, not a new
 * business rule) but are needed for any usable Owner/Manager-facing CRUD, matching precedent. */
export interface CouponTemplate {
  id: string;
  merchantId: string;
  name: string;
  description: string;
  type: CouponType;
  enabled: boolean;
  conditions: CouponConditions;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type CouponInstanceStatus = "AVAILABLE" | "USED" | "EXPIRED";

/**
 * `couponInstances/{instanceId}` (§5). `code` is not in §5's compact list but is required to
 * implement §14's explicit "Coupon Code (ลูกค้ากรอกโค้ดเอง) และ QR-only ต้องรองรับทั้งคู่" —
 * both formats resolve through the SAME lookup (by `code`), matching how Phase 3's member QR
 * encodes `memberCode` rather than the raw Firestore doc id (never expose an internal id via a
 * scannable code). `usedBranchId` mirrors `voucherInstances.usedBranchId` (§5's Reward entry) —
 * §14's coupon schema line omits it, but the Redemption Flow explicitly validates "branch" at
 * redeem time, so recording which branch a redemption happened at is the same
 * documented-but-unspecified-shape fill as `voucherInstances` already established, not new logic.
 */
export interface CouponInstance {
  id: string;
  merchantId: string;
  membershipId: string;
  couponTemplateId: string;
  issuedVia: CouponIssuedVia;
  code: string;
  status: CouponInstanceStatus;
  issuedAt: Timestamp;
  expiresAt: Timestamp | null;
  usedAt: Timestamp | null;
  usedByStaffId: string | null;
  usedBranchId: string | null;
}
