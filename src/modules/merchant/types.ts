import type { Timestamp } from "firebase-admin/firestore";

/** `merchants/{merchantId}.staffLimits` — config-driven, never hard-coded (§9, §34). */
export interface StaffLimits {
  maxPointsPerTransaction: number;
  maxPointsPerHour: number;
  maxPointsPerDay: number;
  manualAdjustmentLimit: number;
  managerApprovalThreshold: number;
}

/** `merchants/{merchantId}.segmentRulesConfig` — config-driven thresholds (§15, §34). */
export interface SegmentRulesConfig {
  inactiveAfterDays: number;
  atRiskAfterDays: number;
  regularMinVisits30d: number;
}

/**
 * `merchants/{merchantId}.pointsExpirationPolicy` — §12: "Point Expiration Policy —
 * Config-driven: Merchant เลือกได้ Never expire / Expire X days after earning / Expire fixed
 * date / Season based". §5's merchant field list doesn't spell out an exact field name/shape for
 * this (unlike `staffLimits`/`segmentRulesConfig`, which are named explicitly) — this shape fills
 * that documented-but-unspecified requirement, same category of decision as `BrandingConfig` in
 * Phase 2. `SEASON_BASED` is intentionally left unimplemented at the computation layer (see
 * `src/modules/points/rule-engine.ts`) — "season" isn't defined anywhere in the architecture, so
 * guessing a shape here would be inventing a business rule, not filling a gap. `NEVER` is the
 * safe default in `createMerchantWithOwner`.
 */
export type PointsExpirationPolicy =
  | { type: "NEVER" }
  | { type: "DAYS_AFTER_EARNING"; days: number }
  | { type: "FIXED_DATE"; date: Timestamp }
  | { type: "SEASON_BASED" };

export interface BrandingConfig {
  logoUrl?: string;
  coverUrl?: string;
  primaryColor?: string;
}

/**
 * `merchants/{merchantId}.reportSettings` — §5, §24 "Report Settings Schema Location" (Phase 8,
 * Locked): embedded field on `merchants`, same pattern as `staffLimits`/`segmentRulesConfig`.
 * Item values must stay within §24's own documented per-frequency item lists — this union is
 * exhaustive on purpose, not an open string, so an invented item name is a compile error.
 * Delivery channel is deliberately NOT part of this shape in V1 — Dashboard-only, per §24 "Report
 * Delivery Channel Scope" (Phase 8, Locked); there is nothing for the Owner to choose yet.
 */
export type DailyReportItem =
  | "NEW_MEMBERS"
  | "ACTIVE"
  | "POINTS"
  | "REWARDS"
  | "COUPONS"
  | "STAFF_ACTIVITY";
export type WeeklyReportItem = "GROWTH" | "RETURNING" | "AT_RISK" | "INACTIVE" | "PROMOTION_PERFORMANCE";
export type MonthlyReportItem =
  | "MEMBERSHIP_GROWTH"
  | "RETENTION"
  | "REWARD_COUPON_PERFORMANCE"
  | "STAFF_SUMMARY";

export interface ReportSettings {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  monthlyEnabled: boolean;
  dailyItems: DailyReportItem[];
  weeklyItems: WeeklyReportItem[];
  monthlyItems: MonthlyReportItem[];
}

export interface MerchantRecord {
  id: string;
  name: string;
  slug: string;
  businessType: string;
  branding: BrandingConfig;
  /** IANA timezone, e.g. "Asia/Bangkok" — default only, never hard-coded elsewhere (§0). */
  timezone: string;
  staffLimits: StaffLimits;
  segmentRulesConfig: SegmentRulesConfig;
  pointsExpirationPolicy: PointsExpirationPolicy;
  reportSettings: ReportSettings;
  ownerUserId: string;
  createdAt: Timestamp;
}

export interface BranchRecord {
  id: string;
  name: string;
  address: string;
  isActive: boolean;
}
