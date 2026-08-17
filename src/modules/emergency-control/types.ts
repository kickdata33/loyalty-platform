import type { Timestamp } from "firebase-admin/firestore";

/**
 * `emergencyControls/{merchantId}` — FINAL-ARCHITECTURE.md §37.2 (Phase 9, Locked). Server-write
 * only, deny-all client access. Deliberately separate from `subscriptions/{merchantId}` (§25) —
 * this is incident-response/ops state, never billing state; §25's Single Source of Truth is
 * unaffected by this collection.
 *
 * A missing document means every capability is enabled (the merchant has never been toggled) —
 * every reader in this module treats "document does not exist" the same as "all false" rather
 * than throwing, so normal operation never requires a Super Admin to have visited a merchant
 * first.
 */
export type EmergencyCapability =
  | "staffSuspended"
  | "pointsEngineFrozen"
  | "automationDisabled"
  | "broadcastDisabled";

export const EMERGENCY_CAPABILITIES: readonly EmergencyCapability[] = [
  "staffSuspended",
  "pointsEngineFrozen",
  "automationDisabled",
  "broadcastDisabled",
];

export interface EmergencyControlRecord {
  merchantId: string;
  staffSuspended: boolean;
  pointsEngineFrozen: boolean;
  automationDisabled: boolean;
  broadcastDisabled: boolean;
  updatedBy: string | null;
  updatedAt: Timestamp | null;
  reason: string | null;
}
