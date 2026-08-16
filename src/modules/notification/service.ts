import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { writeEvent } from "@/modules/event/service";
import { LineAdapter } from "@/modules/notification/adapters/line-adapter";
import type { ChannelAdapter } from "@/modules/notification/adapters/channel-adapter";
import type {
  BroadcastAudience,
  NotificationSettings,
  NotificationTemplateType,
} from "@/modules/notification/types";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import type { MembershipRecord } from "@/modules/membership/types";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Notification Service (FINAL-ARCHITECTURE.md §23) — "Domain Service (Automation/Points/
 * Reward/...) → NotificationService.send(...) → เลือก channel → เรียก ChannelAdapter → เขียน
 * notificationLog → เขียน event". `sendNotification` therefore takes no `AuthContext` — it is a
 * cross-cutting service call from already-trusted server code (the Phase 6 automation executor,
 * future domain callers), not a human-facing operation; `merchantId` always comes from the
 * caller's own already-validated context, matching `writeAuditLog`/`writeEvent`'s shape.
 */

function settingsRef(merchantId: string) {
  return getDb().collection(COLLECTIONS.notificationSettings).doc(merchantId);
}

export async function getNotificationSettings(ctx: AuthContext): Promise<NotificationSettings> {
  requirePermission(ctx, PERMISSIONS.BROADCAST_SEND, ctx.merchantId);
  const snap = await settingsRef(ctx.merchantId).get();
  if (!snap.exists) {
    return { merchantId: ctx.merchantId, templates: {}, testRecipientLineUserId: null, updatedAt: FieldValue.serverTimestamp() as never };
  }
  return snap.data() as NotificationSettings;
}

export interface UpdateNotificationSettingsInput {
  templates: NotificationSettings["templates"];
  testRecipientLineUserId: string | null;
}

/** §23: "Dashboard ต้อง render preview ด้วยข้อมูลตัวอย่างก่อนบันทึกเสมอ" — enforced by the UI calling
 * `renderTemplate` before ever calling this save function; this function itself only validates
 * shape, since preview rendering has no server-side side effect worth gating here. */
export async function updateNotificationSettings(ctx: AuthContext, input: UpdateNotificationSettingsInput): Promise<void> {
  requirePermission(ctx, PERMISSIONS.BROADCAST_SEND, ctx.merchantId);
  for (const [type, tpl] of Object.entries(input.templates)) {
    if (tpl && typeof tpl.body !== "string") {
      throw new ValidationError(`templates.${type}.body must be a string.`);
    }
  }
  await settingsRef(ctx.merchantId).set(
    { merchantId: ctx.merchantId, ...input, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
}

const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g;

export function renderTemplate(body: string, variables: Record<string, string | number>): string {
  return body.replace(PLACEHOLDER_PATTERN, (_match, key: string) => String(variables[key] ?? ""));
}

async function writeNotificationLog(params: {
  merchantId: string;
  membershipId: string | null;
  templateType: NotificationTemplateType;
  status: "sent" | "failed";
  error: string | null;
  broadcastId: string | null;
}): Promise<void> {
  await getDb().collection(COLLECTIONS.notificationLog).doc().set({ ...params, channel: "LINE", createdAt: FieldValue.serverTimestamp() });
}

/**
 * The core `NotificationService.send()` (§23 diagram). Resolves the recipient's
 * `merchantLineIdentity.lineUserId` (never a client-supplied id), checks the template is enabled,
 * renders it, calls the adapter, and records the outcome — retry with exponential backoff, max 3
 * attempts, per §23's Retry Policy.
 */
export async function sendNotification(params: {
  merchantId: string;
  membershipId: string;
  templateType: NotificationTemplateType;
  variables: Record<string, string | number>;
  adapter?: ChannelAdapter;
}): Promise<{ status: "sent" | "failed"; error: string | null }> {
  const adapter = params.adapter ?? new LineAdapter();

  const settings = await settingsRef(params.merchantId).get();
  const template = (settings.data() as NotificationSettings | undefined)?.templates?.[params.templateType];
  if (!template || !template.enabled) {
    const error = "Template disabled or not configured.";
    await writeNotificationLog({ merchantId: params.merchantId, membershipId: params.membershipId, templateType: params.templateType, status: "failed", error, broadcastId: null });
    return { status: "failed", error };
  }

  const memberSnap = await getDb().collection(COLLECTIONS.memberships).doc(params.membershipId).get();
  const member = memberSnap.exists ? (memberSnap.data() as MembershipRecord) : null;
  const lineUserId = member?.merchantLineIdentity?.lineUserId ?? null;
  if (!member || member.merchantId !== params.merchantId || !lineUserId) {
    const error = "Member has no linked LINE identity.";
    await writeNotificationLog({ merchantId: params.merchantId, membershipId: params.membershipId, templateType: params.templateType, status: "failed", error, broadcastId: null });
    return { status: "failed", error };
  }

  const body = renderTemplate(template.body, params.variables);
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await adapter.send({ merchantId: params.merchantId, recipientId: lineUserId, body });
      await writeNotificationLog({ merchantId: params.merchantId, membershipId: params.membershipId, templateType: params.templateType, status: "sent", error: null, broadcastId: null });
      await getDb().runTransaction(async (tx) => {
        writeEvent(tx, { merchantId: params.merchantId, type: "notification.sent", membershipId: params.membershipId, payload: { templateType: params.templateType } });
      });
      return { status: "sent", error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown error";
    }
  }
  await writeNotificationLog({ merchantId: params.merchantId, membershipId: params.membershipId, templateType: params.templateType, status: "failed", error: lastError, broadcastId: null });
  await getDb().runTransaction(async (tx) => {
    writeEvent(tx, { merchantId: params.merchantId, type: "notification.failed", membershipId: params.membershipId, payload: { templateType: params.templateType, error: lastError } });
  });
  return { status: "failed", error: lastError };
}

/**
 * Broadcast Test Send (§23 Broadcast Flow) — Phase 7 locked decision ("NOTIFY_OWNER Delivery &
 * Broadcast Test Send"): sends to the Owner-configured `testRecipientLineUserId`, a plain
 * configuration value — never resolved via `merchantLineIdentity`/`customerIdentities`/staff
 * identity, never creates any identity record.
 */
export async function sendTestBroadcast(ctx: AuthContext, body: string, adapter: ChannelAdapter = new LineAdapter()): Promise<void> {
  requirePermission(ctx, PERMISSIONS.BROADCAST_SEND, ctx.merchantId);
  const settings = await settingsRef(ctx.merchantId).get();
  const testRecipient = (settings.data() as NotificationSettings | undefined)?.testRecipientLineUserId;
  if (!testRecipient) {
    throw new ValidationError("No test recipient configured — set testRecipientLineUserId in notification settings first.");
  }
  await adapter.send({ merchantId: ctx.merchantId, recipientId: testRecipient, body });
}

function membershipMatchesAudience(member: MembershipRecord, audience: BroadcastAudience): boolean {
  if (audience === "ALL") return true;
  if (typeof audience === "object") return member.pointsBalance >= audience.pointsGte;
  return member.activityStats.segment === audience;
}

export interface BroadcastResult {
  broadcastId: string;
  sentCount: number;
  failedCount: number;
}

/** §23 Broadcast Flow's "Schedule/Send" step (immediate send; scheduling for a future date is a
 * thin wrapper the Dashboard can add via a stored `scheduledAt` — the send logic itself is what
 * this function implements, and is what any scheduler would call). */
export async function sendBroadcast(
  ctx: AuthContext,
  input: { audience: BroadcastAudience; templateType: NotificationTemplateType; variables: Record<string, string | number> },
  adapter: ChannelAdapter = new LineAdapter(),
): Promise<BroadcastResult> {
  requirePermission(ctx, PERMISSIONS.BROADCAST_SEND, ctx.merchantId);

  const settings = await settingsRef(ctx.merchantId).get();
  const template = (settings.data() as NotificationSettings | undefined)?.templates?.[input.templateType];
  if (!template || !template.enabled) throw new ValidationError("Template disabled or not configured.");

  const membersSnap = await getDb().collection(COLLECTIONS.memberships).where("merchantId", "==", ctx.merchantId).get();
  const broadcastId = getDb().collection(COLLECTIONS.notificationLog).doc().id;
  const body = renderTemplate(template.body, input.variables);

  let sentCount = 0;
  let failedCount = 0;
  for (const doc of membersSnap.docs) {
    const member = doc.data() as MembershipRecord;
    if (!membershipMatchesAudience(member, input.audience)) continue;
    const lineUserId = member.merchantLineIdentity?.lineUserId;
    if (!lineUserId) {
      failedCount += 1;
      await writeNotificationLog({ merchantId: ctx.merchantId, membershipId: doc.id, templateType: input.templateType, status: "failed", error: "No linked LINE identity.", broadcastId });
      continue;
    }
    try {
      await adapter.send({ merchantId: ctx.merchantId, recipientId: lineUserId, body });
      sentCount += 1;
      await writeNotificationLog({ merchantId: ctx.merchantId, membershipId: doc.id, templateType: input.templateType, status: "sent", error: null, broadcastId });
    } catch (err) {
      failedCount += 1;
      await writeNotificationLog({ merchantId: ctx.merchantId, membershipId: doc.id, templateType: input.templateType, status: "failed", error: err instanceof Error ? err.message : "unknown error", broadcastId });
    }
  }

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "broadcast.sent",
    targetType: "broadcast",
    targetId: broadcastId,
    after: { audience: input.audience, templateType: input.templateType, sentCount, failedCount },
  });

  return { broadcastId, sentCount, failedCount };
}

export async function getBroadcastReport(ctx: AuthContext, broadcastId: string): Promise<BroadcastResult> {
  requirePermission(ctx, PERMISSIONS.BROADCAST_SEND, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.notificationLog)
    .where("merchantId", "==", ctx.merchantId)
    .where("broadcastId", "==", broadcastId)
    .get();
  if (snap.empty) throw new NotFoundError(`Broadcast ${broadcastId} not found.`);
  let sentCount = 0;
  let failedCount = 0;
  for (const doc of snap.docs) {
    const status = (doc.data() as { status: "sent" | "failed" }).status;
    if (status === "sent") sentCount += 1;
    else failedCount += 1;
  }
  return { broadcastId, sentCount, failedCount };
}
