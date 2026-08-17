import type { Timestamp } from "firebase-admin/firestore";

/** §23: event types a merchant can enable/disable a template for. */
export type NotificationTemplateType =
  | "POINTS_EARNED"
  | "POINTS_USED"
  | "REWARD_AVAILABLE"
  | "REWARD_REDEEMED"
  | "COUPON_ISSUED"
  | "COUPON_EXPIRING"
  | "COUPON_USED"
  | "WELCOME_MEMBER"
  | "PROMOTION";

export interface NotificationTemplate {
  enabled: boolean;
  body: string; // may contain {{memberName}}, {{points}}, etc.
}

/** `notificationSettings/{merchantId}` — §5, §23. `testRecipientLineUserId` is the Phase 7
 * "NOTIFY_OWNER Delivery & Broadcast Test Send" locked decision's configuration-only test
 * recipient — never resolved from any identity, just a value Owner types in. */
export interface NotificationSettings {
  merchantId: string;
  templates: Partial<Record<NotificationTemplateType, NotificationTemplate>>;
  testRecipientLineUserId: string | null;
  updatedAt: Timestamp;
}

export type NotificationChannel = "LINE";
export type NotificationDeliveryStatus = "sent" | "failed";

/** `notificationLog/{logId}` — §5, §23, append-only. */
export interface NotificationLogEntry {
  merchantId: string;
  membershipId: string | null;
  channel: NotificationChannel;
  templateType: NotificationTemplateType;
  status: NotificationDeliveryStatus;
  error: string | null;
  broadcastId: string | null;
  createdAt: Timestamp;
}

export type BroadcastAudience =
  | "ALL"
  | "ACTIVE"
  | "AT_RISK"
  | "INACTIVE"
  | "VIP"
  | { pointsGte: number };

/** `broadcasts/{broadcastId}` — §26 "Broadcast spam / message flooding", §38.1 (Phase 10,
 * Locked). One document per `sendBroadcast()` call — distinct from the per-recipient
 * `notificationLog` above, and is the rate-limit source of truth (a `count()` aggregate over
 * this collection, not `notificationLog`, since Firestore has no "count distinct broadcastId"
 * aggregation). Also doubles as a genuine "broadcast history" list. */
export interface BroadcastRecord {
  merchantId: string;
  templateType: NotificationTemplateType;
  audience: BroadcastAudience;
  sentAt: Timestamp;
  sentCount: number;
  failedCount: number;
}
