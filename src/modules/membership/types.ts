import type { Timestamp } from "firebase-admin/firestore";

export type ProfileSource = "CUSTOMER_INPUT" | "STAFF_INPUT" | "LINE_PROFILE_AUTOFILL";
export type Segment = "NEW" | "ACTIVE" | "REGULAR" | "VIP" | "AT_RISK" | "INACTIVE";

export interface MerchantProfile {
  displayName: string;
  phone: string | null;
  email: string | null;
  consentMarketing: boolean;
  profileSource: ProfileSource;
}

export interface MerchantLineIdentity {
  channelId: string;
  lineUserId: string;
  linkedAt: Timestamp;
  friendshipStatus: string;
}

export interface ActivityStats {
  lastVisitAt: Timestamp | null;
  visitCount30d: number;
  visitCount90d: number;
  firstVisitAt: Timestamp | null;
  segment: Segment;
}

/** `memberships/{membershipId}` — top-level, §5, §7. */
export interface MembershipRecord {
  id: string;
  platformCustomerId: string;
  merchantId: string;
  branchId: string | null;
  memberCode: string;
  joinedAt: Timestamp;
  merchantProfile: MerchantProfile;
  merchantLineIdentity: MerchantLineIdentity | null;
  pointsBalance: number;
  pointsBalanceUpdatedAt: Timestamp;
  tags: string[];
  activityStats: ActivityStats;
}
