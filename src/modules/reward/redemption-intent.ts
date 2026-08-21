import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { redeemReward } from "@/modules/reward/service";
import type { RewardTemplate } from "@/modules/reward/types";
import { generateQrCodeDataUrl } from "@/modules/points/qr";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import { NotFoundError, TenantIsolationError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Customer self-service reward redemption (new work, approved beyond Phase 4/7's original DoD).
 *
 * Flow: member picks a reward in the portal -> `createRedemptionIntent` makes a short-lived,
 * one-time PENDING intent + QR (encoding the intent's own doc id, nothing else) -> staff scans it
 * with the EXISTING dashboard QR scanner -> `getRedemptionIntentPreview` shows staff the member/
 * reward/points details -> staff explicitly confirms -> `confirmRedemptionIntent` performs the
 * actual redemption by calling the EXISTING `redeemReward()` — no parallel points/stock/FIFO logic
 * anywhere in this file; every authoritative business rule (enabled/stock/limitPerMember/branch/
 * date/points-sufficiency) is `redeemReward()`'s own, re-checked fresh at confirm time exactly as
 * it always has been for staff-initiated redemptions.
 *
 * Server-authoritative throughout: the client never supplies `rewardTemplateId`/points/balance at
 * confirm time — only an opaque `intentId` staff got by scanning a QR. Tenant-scoped: every load
 * checks `merchantId` against the caller's own (never trusts a cross-tenant intentId to exist).
 */

const REDEMPTION_INTENT_TTL_MS = 5 * 60 * 1000; // ~5 minutes, per spec

export type RedemptionIntentStatus = "PENDING" | "CONFIRMED" | "FAILED" | "EXPIRED";

interface RedemptionIntentDoc {
  merchantId: string;
  membershipId: string;
  rewardTemplateId: string;
  status: RedemptionIntentStatus;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  confirmedAt: Timestamp | null;
  confirmedByStaffId: string | null;
  voucherId: string | null;
}

function intentRef(intentId: string) {
  return getDb().collection(COLLECTIONS.redemptionIntents).doc(intentId);
}

export interface CreateRedemptionIntentResult {
  intentId: string;
  qrCodeDataUrl: string;
  expiresAt: string;
}

/**
 * Customer-facing (no `AuthContext` — same posture as `resolveOrCreateLineMembership`): the
 * caller has already resolved `merchantId`/`membershipId` from the customer's own verified LINE
 * identity. `rewardTemplateId` is the only value taken from client input here, and it's validated
 * against real Firestore data before an intent is created — never trusted blindly.
 *
 * The points-sufficiency check here is a best-effort UX pre-check ONLY (avoids generating a QR
 * that's certain to fail) — NOT the authoritative check. `redeemReward()` re-checks the real
 * balance atomically, inside its own transaction, at confirm time regardless of what this said.
 */
export async function createRedemptionIntent(
  merchantId: string,
  membershipId: string,
  rewardTemplateId: string,
): Promise<CreateRedemptionIntentResult> {
  const db = getDb();

  const templateSnap = await db.collection(COLLECTIONS.rewardTemplates).doc(rewardTemplateId).get();
  if (!templateSnap.exists) throw new NotFoundError("Reward not found.");
  const template = { id: templateSnap.id, ...(templateSnap.data() as Omit<RewardTemplate, "id">) };
  if (template.merchantId !== merchantId) throw new NotFoundError("Reward not found."); // don't leak cross-tenant existence
  if (!template.enabled) throw new ValidationError("This reward is not currently available.");

  const membershipSnap = await db.collection(COLLECTIONS.memberships).doc(membershipId).get();
  if (!membershipSnap.exists) throw new NotFoundError("Membership not found.");
  const membership = membershipSnap.data() as { merchantId: string; pointsBalance: number };
  if (membership.merchantId !== merchantId) {
    throw new TenantIsolationError("Membership does not belong to this merchant.");
  }
  if (membership.pointsBalance < template.requiredPoints) {
    throw new ValidationError("Not enough points to redeem this reward.");
  }

  const expiresAtDate = new Date(Date.now() + REDEMPTION_INTENT_TTL_MS);
  const ref = db.collection(COLLECTIONS.redemptionIntents).doc();
  const doc: RedemptionIntentDoc = {
    merchantId,
    membershipId,
    rewardTemplateId,
    status: "PENDING",
    createdAt: FieldValue.serverTimestamp() as unknown as Timestamp,
    expiresAt: Timestamp.fromDate(expiresAtDate),
    confirmedAt: null,
    confirmedByStaffId: null,
    voucherId: null,
  };
  await ref.set(doc);

  const qrCodeDataUrl = await generateQrCodeDataUrl(ref.id);
  return { intentId: ref.id, qrCodeDataUrl, expiresAt: expiresAtDate.toISOString() };
}

/** Loads an intent, enforcing tenant scoping and lazy expiry (same idiom as Coupon's locked
 * "Lazy Validation for V1" decision — flips PENDING-but-past-expiresAt to EXPIRED on next touch,
 * no scheduled job needed). A cross-tenant intentId is reported as NotFoundError, never a more
 * specific error, so staff can never learn a foreign intent exists (§10, §26 IDOR posture). */
async function loadIntentForMerchant(
  intentId: string,
  merchantId: string,
): Promise<{ id: string } & RedemptionIntentDoc> {
  const snap = await intentRef(intentId).get();
  if (!snap.exists) throw new NotFoundError("Redemption code not found.");
  const data = { id: snap.id, ...(snap.data() as RedemptionIntentDoc) };
  if (data.merchantId !== merchantId) throw new NotFoundError("Redemption code not found.");
  if (data.status === "PENDING" && data.expiresAt.toMillis() <= Date.now()) {
    await intentRef(intentId).update({ status: "EXPIRED" });
    data.status = "EXPIRED";
  }
  return data;
}

/** Customer-facing status poll (no `AuthContext` — same posture as `createRedemptionIntent`). The
 * caller has already resolved their OWN `membershipId` from their verified identity; this extra
 * `membership.id !== membershipId` check means a customer can never poll the status of an intent
 * belonging to a different member, even within the same merchant (a plain `loadIntentForMerchant`
 * call alone would only prevent cross-*tenant* access, not cross-*member* access within one
 * tenant) — reported identically to "not found" so a guessed foreign intentId reveals nothing. */
export async function getRedemptionIntentStatusForCustomer(
  merchantId: string,
  membershipId: string,
  intentId: string,
): Promise<{ status: RedemptionIntentStatus }> {
  const intent = await loadIntentForMerchant(intentId, merchantId);
  if (intent.membershipId !== membershipId) throw new NotFoundError("Redemption code not found.");
  return { status: intent.status };
}

export interface RedemptionIntentPreview {
  intentId: string;
  memberDisplayName: string;
  memberCode: string;
  currentPointsBalance: number;
  rewardName: string;
  requiredPoints: number;
  status: RedemptionIntentStatus;
  expiresAt: string;
}

/** Staff-facing (after scanning the QR) — read-only preview, never mutates anything. Shows staff
 * exactly what they need to make an informed confirm decision (§ requirement: "Staff sees member
 * name, reward name, points cost, and current balance"), reading the member's CURRENT balance
 * fresh (not whatever it was when the intent was created). */
export async function getRedemptionIntentPreview(ctx: AuthContext, intentId: string): Promise<RedemptionIntentPreview> {
  requirePermission(ctx, PERMISSIONS.REWARD_REDEEM, ctx.merchantId);
  const intent = await loadIntentForMerchant(intentId, ctx.merchantId);

  const db = getDb();
  const [membershipSnap, templateSnap] = await Promise.all([
    db.collection(COLLECTIONS.memberships).doc(intent.membershipId).get(),
    db.collection(COLLECTIONS.rewardTemplates).doc(intent.rewardTemplateId).get(),
  ]);
  if (!membershipSnap.exists) throw new NotFoundError("Member not found.");
  if (!templateSnap.exists) throw new NotFoundError("Reward not found.");
  const membership = membershipSnap.data() as {
    merchantProfile: { displayName: string };
    memberCode: string;
    pointsBalance: number;
  };
  const template = templateSnap.data() as { name: string; requiredPoints: number };

  return {
    intentId: intent.id,
    memberDisplayName: membership.merchantProfile.displayName,
    memberCode: membership.memberCode,
    currentPointsBalance: membership.pointsBalance,
    rewardName: template.name,
    requiredPoints: template.requiredPoints,
    status: intent.status,
    expiresAt: intent.expiresAt.toDate().toISOString(),
  };
}

export interface ConfirmRedemptionIntentResult {
  voucherId: string;
  memberDisplayName: string;
  rewardName: string;
}

/**
 * Staff-facing confirm — the only function in this file that actually redeems anything, and it
 * does so purely by delegating to the existing `redeemReward()`.
 *
 * Two independent, defense-in-depth layers against double redemption/races:
 * 1. An atomic PENDING -> CONFIRMED compare-and-set on the intent doc itself, inside a Firestore
 *    transaction — Firestore's optimistic-concurrency retry means only ONE of two concurrent
 *    confirm calls can win this; the other re-reads on retry, sees a non-PENDING status, and
 *    rejects before ever calling `redeemReward()`.
 * 2. `idempotencyKey: intentId` passed into `redeemReward()` itself — reuses that function's own,
 *    already-transactional idempotency check (`checkIdempotencyKey`), so even in the vanishingly
 *    unlikely case both confirm calls got past layer 1, the actual points deduction/voucher
 *    creation still only ever happens once, atomically, with the second call safely replaying the
 *    same result rather than double-spending.
 *
 * If `redeemReward()` itself throws (balance/stock changed between intent creation and
 * confirmation, reward got disabled, etc.), the intent is marked FAILED rather than left
 * incorrectly CONFIRMED with no voucher — honestly non-reusable, matching "one-time" either way.
 */
export async function confirmRedemptionIntent(
  ctx: AuthContext,
  intentId: string,
  branchId: string | null = null,
): Promise<ConfirmRedemptionIntentResult> {
  requirePermission(ctx, PERMISSIONS.REWARD_REDEEM, ctx.merchantId);

  const db = getDb();

  const intent = await db.runTransaction(async (tx) => {
    const snap = await tx.get(intentRef(intentId));
    if (!snap.exists) throw new NotFoundError("Redemption code not found.");
    const data = { id: snap.id, ...(snap.data() as RedemptionIntentDoc) };
    if (data.merchantId !== ctx.merchantId) throw new NotFoundError("Redemption code not found.");

    if (data.status === "PENDING" && data.expiresAt.toMillis() <= Date.now()) {
      tx.update(intentRef(intentId), { status: "EXPIRED" });
      throw new ValidationError("This redemption code has expired.");
    }
    if (data.status !== "PENDING") {
      const message =
        data.status === "CONFIRMED"
          ? "This redemption code has already been used."
          : data.status === "EXPIRED"
            ? "This redemption code has expired."
            : "This redemption code is no longer valid.";
      throw new ValidationError(message);
    }

    tx.update(intentRef(intentId), {
      status: "CONFIRMED",
      confirmedAt: FieldValue.serverTimestamp(),
      confirmedByStaffId: ctx.authUid,
    });
    return data;
  });

  let voucherId: string;
  try {
    const result = await redeemReward(ctx, {
      membershipId: intent.membershipId,
      rewardTemplateId: intent.rewardTemplateId,
      branchId,
      visitSource: "STAFF_SCAN",
      idempotencyKey: intentId,
    });
    voucherId = result.voucherId;
  } catch (err) {
    await intentRef(intentId).update({ status: "FAILED" });
    throw err;
  }

  await intentRef(intentId).update({ voucherId });

  const [membershipSnap, templateSnap] = await Promise.all([
    db.collection(COLLECTIONS.memberships).doc(intent.membershipId).get(),
    db.collection(COLLECTIONS.rewardTemplates).doc(intent.rewardTemplateId).get(),
  ]);
  const membership = membershipSnap.data() as { merchantProfile: { displayName: string } } | undefined;
  const template = templateSnap.data() as { name: string } | undefined;

  return {
    voucherId,
    memberDisplayName: membership?.merchantProfile.displayName ?? "",
    rewardName: template?.name ?? "",
  };
}
