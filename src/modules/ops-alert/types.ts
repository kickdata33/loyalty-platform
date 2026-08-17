import type { Timestamp } from "firebase-admin/firestore";

/**
 * `platformOpsSettings/{docId}` — FINAL-ARCHITECTURE.md §38.2 (Phase 10 Blocker 2, Locked —
 * Option C, in-app half; live-delivery mechanism revised to Option B, see §38.2 addendum).
 * Single well-known document (`docId = "default"`), server-write-only, deny-all client access —
 * same isolation tier as `emergencyControls`/`supportSessions` (§37).
 *
 * `criticalAlertRecipient` is a plain configured value, never resolved via identity verification
 * — same pattern as `notificationSettings.testRecipientLineUserId` (Phase 7 lock). **Stored for
 * forward compatibility only — `reportCriticalError()` does not currently read or act on this
 * value; live LINE delivery is deferred (§38.2 addendum, Option B, locked) because every LINE
 * channel in this architecture is per-merchant (§19/§20) and none may be reused for a
 * platform-level alert.** Live delivery requires a separately approved platform-level LINE
 * notification channel/credential architecture in a future phase.
 */
export interface PlatformOpsSettings {
  criticalAlertRecipient: { lineUserId: string } | null;
  updatedBy: string | null;
  updatedAt: Timestamp | null;
}

/** `criticalErrors/{id}` — §38.2, append-only, deny-all client (same tier as `auditLogs`, §18).
 * System-error audit trail — written by `reportCriticalError()` on EVERY call. `alertSent` is
 * currently always `false` — live delivery is deferred (§38.2 addendum, Option B) — kept as a
 * field so a future platform-level delivery mechanism can start setting it `true` without a
 * schema change. */
export interface CriticalErrorRecord {
  id: string;
  /** `null` for platform-wide errors not tied to one merchant (e.g. a scheduled job failing for
   * every merchant in one run). */
  merchantId: string | null;
  /** Where this was reported from, e.g. "balanceReconciliationJob", "dailyAutomationBatch". */
  source: string;
  message: string;
  /** Deliberately excludes member PII (phone/email/display name) — only opaque ids/counts, per
   * §38.2's explicit constraint. */
  context: Record<string, unknown> | null;
  /** Always `false` currently — see the type doc comment above. */
  alertSent: boolean;
  createdAt: Timestamp;
}
