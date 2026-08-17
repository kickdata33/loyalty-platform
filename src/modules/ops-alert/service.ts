import { FieldValue } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { SuperAdminAuthContext } from "@/modules/shared/types";
import type { PlatformOpsSettings } from "@/modules/ops-alert/types";

/**
 * Monitoring & Critical Alert Path — in-app half (FINAL-ARCHITECTURE.md §38.2, Phase 10 Blocker
 * 2, Locked — Option C; live-delivery mechanism revised to Option B, see §38.2 addendum). The
 * GCP-native half (Cloud Monitoring Alerting Policy for general error-rate/scheduled-job-failure
 * signals) is infrastructure configuration, not application code — see
 * `docs/ops/monitoring-alerting-policy.md`.
 *
 * **Live LINE delivery is deferred (§38.2 addendum, Option B, locked).** `LineAdapter` resolves
 * credentials per-merchant (§19/§20) — there is no platform-level LINE channel anywhere in this
 * architecture, so it can never correctly reach a platform-wide ops recipient, and reusing any
 * merchant's own credentials for a platform-level alert is explicitly forbidden (§38.2 addendum:
 * "ห้าม reuse merchant LINE credential ใดๆ สำหรับ platform-level alert เด็ดขาด"). This module
 * therefore never imports `ChannelAdapter`/`LineAdapter` — `reportCriticalError()` only ever
 * writes the `criticalErrors` audit trail. Live delivery requires a separately approved
 * platform-level LINE notification channel/credential architecture in a future phase.
 */

const OPS_SETTINGS_DOC_ID = "default";

function opsSettingsRef() {
  return getDb().collection(COLLECTIONS.platformOpsSettings).doc(OPS_SETTINGS_DOC_ID);
}

/** Super-Admin-only read of the current critical-alert recipient setting. Preserved per §38.2
 * addendum (Option B keeps the settings surface — it's forward-compatible with a future
 * platform-level delivery mechanism — only the delivery attempt itself was removed). Takes no
 * `SuperAdminAuthContext` — gated entirely by the caller (`/api/superadmin/ops-settings` calls
 * `requireSuperAdminAuthContext` first), same pattern as `listPackages`/`getSystemHealth` (§37). */
export async function getCriticalAlertSettings(): Promise<PlatformOpsSettings> {
  const snap = await opsSettingsRef().get();
  if (!snap.exists) return { criticalAlertRecipient: null, updatedBy: null, updatedAt: null };
  return snap.data() as PlatformOpsSettings;
}

/** Super-Admin-only write — audited (§18), same pattern as `setEmergencyControl` (§37.2):
 * mandatory reason, before/after recorded. Preserved per §38.2 addendum — the recipient value is
 * stored for forward compatibility with a future platform-level delivery mechanism, but
 * `reportCriticalError()` does not currently read or act on it (delivery is deferred). */
export async function setCriticalAlertSettings(
  admin: SuperAdminAuthContext,
  input: { lineUserId: string | null },
  reason: string,
): Promise<void> {
  if (reason.trim().length === 0) {
    throw new ValidationError("reason is required to change the critical alert recipient.");
  }
  const before = await getCriticalAlertSettings();
  const criticalAlertRecipient = input.lineUserId ? { lineUserId: input.lineUserId } : null;

  await opsSettingsRef().set(
    {
      criticalAlertRecipient,
      updatedBy: admin.authUid,
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  await writeAuditLog({
    merchantId: "platform", // not merchant-scoped — a platform-wide config change, same
    // convention as package.created/updated (§37.3, billing-entitlement/service.ts)
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: "ops_settings.critical_alert_recipient_updated",
    targetType: "platformOpsSettings",
    targetId: OPS_SETTINGS_DOC_ID,
    before: { criticalAlertRecipient: before.criticalAlertRecipient },
    after: { criticalAlertRecipient },
    reason,
  });
}

export interface ReportCriticalErrorParams {
  /** `null` for platform-wide errors not tied to one merchant. */
  merchantId: string | null;
  /** Where this was reported from, e.g. "balanceReconciliationJob". */
  source: string;
  message: string;
  /** Deliberately excludes member PII — only opaque ids/counts (§38.2). */
  context?: Record<string, unknown>;
}

/**
 * Reports a critical, business-state-affecting error (§30, §38.2). ALWAYS writes to
 * `criticalErrors` (the audit/history trail) — this is currently the ENTIRE effect of this
 * function. Called from a narrow, fixed set of call sites (`balanceReconciliationJob`,
 * `dailyAutomationBatch`'s and `systemHealthSelfCheck`'s own top-level catch) — never scattered
 * elsewhere (§10 "ห้ามใส่ logic กระจาย" applied to this too).
 *
 * **No live delivery is attempted here (§38.2 addendum, Option B, locked)** — see the module doc
 * comment for why. Super Admin currently monitors via the `criticalErrors` collection (through a
 * future `/superadmin` view) plus the GCP-native alerting half (§38.2a,
 * `docs/ops/monitoring-alerting-policy.md`) for live paging.
 *
 * NEVER throws — a failure to record must never crash the caller's own error handling.
 */
export async function reportCriticalError(params: ReportCriticalErrorParams): Promise<void> {
  try {
    await getDb()
      .collection(COLLECTIONS.criticalErrors)
      .doc()
      .set({
        merchantId: params.merchantId,
        source: params.source,
        message: params.message,
        context: params.context ?? null,
        // Always false — live delivery is deferred (§38.2 addendum). Kept as a field (rather than
        // removed) so a future platform-level delivery mechanism can start setting it true without
        // a schema change.
        alertSent: false,
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch {
    // The audit-trail write itself must never throw back into the caller's own error handling.
  }
}
