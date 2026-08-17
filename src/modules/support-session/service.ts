import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import { getMerchantRecordOrThrow } from "@/modules/merchant/service";
import { AuthenticationError, AuthorizationError, ConflictError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { SuperAdminAuthContext } from "@/modules/shared/types";
import type { SupportSessionRecord, SupportSnapshot } from "@/modules/support-session/types";

/**
 * Support Session (FINAL-ARCHITECTURE.md §37.1, Phase 9 Blocker 1, Locked — Option A).
 *
 * Ephemeral, server-authoritative, merchant-scoped access grant for Super Admin — see the module
 * doc comment on `SupportSessionRecord` for why this exists instead of touching custom claims.
 * V1 scope is strictly read-only ("View-as"): `getSupportSnapshot` is the only thing a session
 * grants access to; there is no write/mutate path here.
 */

const DEFAULT_TTL_MINUTES = 30;
const MAX_TTL_MINUTES = 120;
const RECENT_LIMIT = 20;

function sessionRef(sessionId: string) {
  return getDb().collection(COLLECTIONS.supportSessions).doc(sessionId);
}

export interface OpenSupportSessionInput {
  merchantId: string;
  reason: string;
  /** Minutes until the session auto-expires — default 30, clamped to a maximum of 120. Not a
   * business rule, just a conservative operational default (§37.1). */
  ttlMinutes?: number;
}

export interface OpenSupportSessionResult {
  sessionId: string;
  expiresAt: Timestamp;
}

/** Opens a new session for `input.merchantId` — always requires a non-empty reason (§37.1). Fails
 * closed (`NotFoundError`, via `getMerchantRecordOrThrow`) if the merchant doesn't exist, so a
 * session can never be opened "for" a merchant that was never real. */
export async function openSupportSession(
  admin: SuperAdminAuthContext,
  input: OpenSupportSessionInput,
): Promise<OpenSupportSessionResult> {
  if (input.reason.trim().length === 0) {
    throw new ValidationError("reason is required to open a Support Session.");
  }
  await getMerchantRecordOrThrow(input.merchantId); // throws NotFoundError if the merchant doesn't exist

  const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_TTL_MINUTES, 1), MAX_TTL_MINUTES);
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + ttlMinutes * 60 * 1000);

  const ref = getDb().collection(COLLECTIONS.supportSessions).doc();
  await ref.set({
    superAdminUid: admin.authUid,
    merchantId: input.merchantId,
    reason: input.reason,
    grantedAt: FieldValue.serverTimestamp(),
    expiresAt,
    revokedAt: null,
    revokedBy: null,
  });

  await writeAuditLog({
    merchantId: input.merchantId,
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: "support_session.opened",
    targetType: "supportSession",
    targetId: ref.id,
    after: { merchantId: input.merchantId, expiresAt: expiresAt.toDate().toISOString() },
    reason: input.reason,
  });

  return { sessionId: ref.id, expiresAt };
}

async function loadSessionOrThrow(sessionId: string): Promise<SupportSessionRecord> {
  const snap = await sessionRef(sessionId).get();
  if (!snap.exists) {
    throw new AuthenticationError("Support Session not found.");
  }
  return { id: snap.id, ...(snap.data() as Omit<SupportSessionRecord, "id">) };
}

/** Validates ownership + liveness of a session and returns it — this is the ONLY function in the
 * codebase that turns a `sessionId` into a trustworthy `merchantId` for Super Admin use (§37.1:
 * "derive merchantId จาก session document เท่านั้น"). Deliberately strict: a session belonging to a
 * different Super Admin, already revoked, or past its `expiresAt` is rejected the same way an
 * expired/revoked Firebase ID Token is — fail closed, no partial trust. */
export async function resolveSupportSession(
  admin: SuperAdminAuthContext,
  sessionId: string,
): Promise<SupportSessionRecord> {
  const session = await loadSessionOrThrow(sessionId);
  if (session.superAdminUid !== admin.authUid) {
    // Deliberately generic — never confirm whether a session id belonging to another Super Admin
    // exists (same reasoning as TenantIsolationError's message, §26 IDOR checklist).
    throw new AuthorizationError("You do not have access to this Support Session.");
  }
  if (session.revokedAt !== null) {
    throw new AuthenticationError("This Support Session has been closed.");
  }
  if (session.expiresAt.toMillis() <= Date.now()) {
    throw new AuthenticationError("This Support Session has expired.");
  }
  return session;
}

/** Deterministic, immediate revocation (§37.1) — checked against the Firestore document on every
 * subsequent call via `resolveSupportSession`, never dependent on token refresh/propagation
 * timing. Idempotent-ish: closing an already-closed session is a `ConflictError`, not silently
 * accepted, so the caller's "Exit Support Mode" UI can tell the two cases apart. */
export async function closeSupportSession(admin: SuperAdminAuthContext, sessionId: string): Promise<void> {
  const session = await loadSessionOrThrow(sessionId);
  if (session.superAdminUid !== admin.authUid) {
    throw new AuthorizationError("You do not have access to this Support Session.");
  }
  if (session.revokedAt !== null) {
    throw new ConflictError("This Support Session has already been closed.");
  }

  await sessionRef(sessionId).update({
    revokedAt: FieldValue.serverTimestamp(),
    revokedBy: admin.authUid,
  });

  await writeAuditLog({
    merchantId: session.merchantId,
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: "support_session.closed",
    targetType: "supportSession",
    targetId: sessionId,
  });
}

/**
 * Read-only "View-as" snapshot (§37.1) — everything a Support Session grants access to in V1.
 * Reads only from collections that are otherwise deny-all to Super Admin's own direct client
 * reads too (pointsLedger, automations, notificationLog — §5 rules); merchant/staff/subscription
 * basics are included for convenience even though they're already directly client-readable via
 * `isSuperAdmin()`. Every read is scoped by `session.merchantId` — never a caller-supplied id.
 * Audited as a view (not just session open/close), per §18 "audit ทุกครั้ง".
 */
export async function getSupportSnapshot(
  admin: SuperAdminAuthContext,
  sessionId: string,
): Promise<SupportSnapshot> {
  const session = await resolveSupportSession(admin, sessionId);
  const merchantId = session.merchantId;
  const db = getDb();

  const [merchantSnap, subSnap, staffCountSnap, membershipCountSnap, ledgerSnap, automationsSnap, notifSnap] =
    await Promise.all([
      db.collection(COLLECTIONS.merchants).doc(merchantId).get(),
      db.collection(COLLECTIONS.subscriptions).doc(merchantId).get(),
      db.collection(COLLECTIONS.staffUsers).where("merchantId", "==", merchantId).count().get(),
      db.collection(COLLECTIONS.memberships).where("merchantId", "==", merchantId).count().get(),
      db
        .collection(COLLECTIONS.pointsLedger)
        .where("merchantId", "==", merchantId)
        .orderBy("createdAt", "desc")
        .limit(RECENT_LIMIT)
        .get(),
      db.collection(COLLECTIONS.automations).where("merchantId", "==", merchantId).get(),
      db
        .collection(COLLECTIONS.notificationLog)
        .where("merchantId", "==", merchantId)
        .orderBy("createdAt", "desc")
        .limit(RECENT_LIMIT)
        .get(),
    ]);

  await writeAuditLog({
    merchantId,
    actorType: "superAdmin",
    actorId: admin.authUid,
    action: "support_session.snapshot_viewed",
    targetType: "merchant",
    targetId: merchantId,
    metadata: { requestId: sessionId },
  });

  const merchant = merchantSnap.exists
    ? (merchantSnap.data() as { name: string; slug: string; businessType: string })
    : null;
  const subscription = subSnap.exists
    ? (subSnap.data() as { packageId: string | null; status: string })
    : null;

  return {
    merchantId,
    merchant: merchant ? { name: merchant.name, slug: merchant.slug, businessType: merchant.businessType } : null,
    subscription,
    staffCount: staffCountSnap.data().count,
    membershipCount: membershipCountSnap.data().count,
    recentPointsLedger: ledgerSnap.docs.map((d) => {
      const data = d.data() as { membershipId: string; type: string; delta: number; reason: string; createdAt: Timestamp | null };
      return { id: d.id, membershipId: data.membershipId, type: data.type, delta: data.delta, reason: data.reason, createdAt: data.createdAt ?? null };
    }),
    automations: automationsSnap.docs.map((d) => {
      const data = d.data() as { name: string; status: string; presentedAs: string };
      return { id: d.id, name: data.name, status: data.status, presentedAs: data.presentedAs };
    }),
    recentNotificationLog: notifSnap.docs.map((d) => {
      const data = d.data() as { templateType: string; status: string; error: string | null; createdAt: Timestamp | null };
      return { id: d.id, templateType: data.templateType, status: data.status, error: data.error, createdAt: data.createdAt ?? null };
    }),
  };
}
