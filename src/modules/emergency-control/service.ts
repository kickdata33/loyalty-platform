import { FieldValue, type Transaction } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import {
  EMERGENCY_CAPABILITIES,
  type EmergencyCapability,
  type EmergencyControlRecord,
} from "@/modules/emergency-control/types";
import { ServiceSuspendedError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { SuperAdminAuthContext } from "@/modules/shared/types";

/**
 * Emergency Control (FINAL-ARCHITECTURE.md §37.2, Phase 9, Locked) — Super Admin kill-switches,
 * kept as a service state fully separate from `subscriptions/{merchantId}` (§25 billing state).
 *
 * This file owns `emergencyControls/{merchantId}` end to end — reads, writes, AND every
 * enforcement check. Every other module that needs to respect a toggle imports one of the
 * `assert*` functions below rather than reading the collection itself, so there is exactly one
 * place that knows this collection's shape (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่").
 */

const DEFAULT_RECORD: Omit<EmergencyControlRecord, "merchantId"> = {
  staffSuspended: false,
  pointsEngineFrozen: false,
  automationDisabled: false,
  broadcastDisabled: false,
  updatedBy: null,
  updatedAt: null,
  reason: null,
};

function controlRef(merchantId: string) {
  return getDb().collection(COLLECTIONS.emergencyControls).doc(merchantId);
}

/** Read the current toggle state for a merchant — a missing document means "nothing has ever
 * been restricted" (all-false), never an error. Super-Admin-only caller (enforced by every API
 * route calling this via `requireSuperAdminAuthContext`, not by this function itself — this
 * module has no concept of Owner/Staff permission, only Super Admin vs. system enforcement). */
export async function getEmergencyControls(
  _admin: SuperAdminAuthContext,
  merchantId: string,
): Promise<EmergencyControlRecord> {
  const snap = await controlRef(merchantId).get();
  if (!snap.exists) return { merchantId, ...DEFAULT_RECORD };
  return { merchantId, ...DEFAULT_RECORD, ...(snap.data() as Partial<EmergencyControlRecord>) };
}

/** Toggles ONE capability for ONE merchant. Always requires a reason — every change is a
 * high-blast-radius action and must be traceable (§37.2, §18). */
export async function setEmergencyControl(
  admin: SuperAdminAuthContext,
  merchantId: string,
  capability: EmergencyCapability,
  enabled: boolean,
  reason: string,
): Promise<void> {
  if (!EMERGENCY_CAPABILITIES.includes(capability)) {
    throw new ValidationError(`Unknown emergency capability: ${capability}`);
  }
  if (reason.trim().length === 0) {
    throw new ValidationError("reason is required to change an emergency control.");
  }

  const ref = controlRef(merchantId);
  const before = await getEmergencyControls(admin, merchantId);

  await ref.set(
    {
      merchantId,
      [capability]: enabled,
      updatedBy: admin.authUid,
      updatedAt: FieldValue.serverTimestamp(),
      reason,
    },
    { merge: true },
  );

  await writeAuditLog({
    merchantId,
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: `emergency_control.${capability}.${enabled ? "enabled" : "disabled"}`,
    targetType: "merchant",
    targetId: merchantId,
    before: { [capability]: before[capability] },
    after: { [capability]: enabled },
    reason,
  });
}

// --- Enforcement (called from other modules — never reimplement these checks elsewhere) --------

/** `staffSuspended` — single choke point: `requireStaffAuthContext()` (`src/lib/api/auth.ts`),
 * the one function every protected Staff/Owner API route calls before anything else. Customer
 * Portal never calls it, so customer-facing reads are never affected (§25 Suspended Behavior:
 * "Customer portal ยังอ่านได้เสมอ"). Plain (non-transactional) read — this is an auth gate evaluated
 * before any transaction begins, not a business-state mutation. */
export async function assertMerchantStaffNotSuspended(merchantId: string): Promise<void> {
  const snap = await controlRef(merchantId).get();
  if (snap.exists && (snap.data() as EmergencyControlRecord).staffSuspended) {
    throw new ServiceSuspendedError(
      "Staff access for this merchant has been temporarily suspended. Contact platform support.",
    );
  }
}

/** `pointsEngineFrozen` — single choke point: `createLedgerEntry()`
 * (`src/modules/points/ledger-service.ts`), the low-level primitive every points-mutating write
 * in the codebase funnels through (earn, manual add, adjust, reverse, reward spend, automation
 * ADD_POINTS) — see §37.2 for why reversal/adjustment are intentionally included, not exempted.
 * Runs as a `tx.get()` so it participates in the caller's own transaction (must be called before
 * any write in that transaction — true at every existing call site, see §37.2). */
export async function assertPointsEngineNotFrozenTx(tx: Transaction, merchantId: string): Promise<void> {
  const snap = await tx.get(controlRef(merchantId));
  if (snap.exists && (snap.data() as EmergencyControlRecord).pointsEngineFrozen) {
    throw new ServiceSuspendedError(
      "The points engine for this merchant has been temporarily frozen by platform support.",
    );
  }
}

/** `automationDisabled` — single choke point: `executeAutomationAction()`
 * (`src/modules/promotion-automation/service.ts`), called by both real-time dispatch and the
 * scheduled batch (§16 "Automation คือ Engine เดียว"). */
export async function assertAutomationNotDisabled(merchantId: string): Promise<void> {
  const snap = await controlRef(merchantId).get();
  if (snap.exists && (snap.data() as EmergencyControlRecord).automationDisabled) {
    throw new ServiceSuspendedError("Automation has been temporarily disabled for this merchant.");
  }
}

/** `broadcastDisabled` — single choke point: `sendBroadcast()`/`sendTestBroadcast()`
 * (`src/modules/notification/service.ts`) only — does NOT gate `sendNotification()` (individual,
 * automation-triggered sends already governed by `automationDisabled`), per §37.2. */
export async function assertBroadcastNotDisabled(merchantId: string): Promise<void> {
  const snap = await controlRef(merchantId).get();
  if (snap.exists && (snap.data() as EmergencyControlRecord).broadcastDisabled) {
    throw new ServiceSuspendedError("Broadcast has been temporarily disabled for this merchant.");
  }
}
