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

export interface BrandingConfig {
  logoUrl?: string;
  coverUrl?: string;
  primaryColor?: string;
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
  ownerUserId: string;
  createdAt: Timestamp;
}

export interface BranchRecord {
  id: string;
  name: string;
  address: string;
  isActive: boolean;
}
