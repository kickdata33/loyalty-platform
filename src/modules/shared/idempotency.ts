import { FieldValue, type Transaction } from "firebase-admin/firestore";

import { ConflictError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

/**
 * Generic idempotency-key check/record, shared across every domain module whose operations must
 * be idempotent (FINAL-ARCHITECTURE.md §27) — Add Points, Redeem Reward, Redeem Coupon, ... This
 * used to live privately inside `points/ledger-service.ts` (Phase 3); extracted here in Phase 4
 * because `reward/service.ts` needs the exact same check-then-record-inside-the-same-transaction
 * pattern and CLAUDE.md forbids duplicating logic across modules ("ห้ามมี logic ซ้ำสองที่").
 *
 * Both functions are transaction-scoped by design (`tx: Transaction` is the first parameter) —
 * they must be called from inside the SAME `runTransaction` callback as the business write they
 * guard, never as a separate check-then-write step (§9, §26).
 */

/** Checks + returns the prior result if this key was already used (idempotent replay), or `null`
 * if this is the first use. Does NOT record the key itself — call `recordIdempotencyKey` after
 * the business write succeeds, within the same transaction. */
export async function checkIdempotencyKey(
  tx: Transaction,
  merchantId: string,
  operationType: string,
  idempotencyKey: string,
): Promise<string | null> {
  if (!idempotencyKey || idempotencyKey.trim().length < 8) {
    throw new ValidationError("idempotencyKey is required (min 8 chars).");
  }
  const ref = getDb().collection(COLLECTIONS.idempotencyKeys).doc(idempotencyKey);
  const snap = await tx.get(ref);
  if (snap.exists) {
    const data = snap.data() as { merchantId: string; operationType: string; resultRef: string };
    if (data.merchantId !== merchantId || data.operationType !== operationType) {
      // Same key reused for a different merchant/operation — never trust it as a replay.
      throw new ConflictError("idempotencyKey was already used for a different operation.");
    }
    return data.resultRef;
  }
  return null;
}

export function recordIdempotencyKey(
  tx: Transaction,
  merchantId: string,
  operationType: string,
  idempotencyKey: string,
  resultRef: string,
): void {
  const ref = getDb().collection(COLLECTIONS.idempotencyKeys).doc(idempotencyKey);
  tx.create(ref, { merchantId, operationType, resultRef, createdAt: FieldValue.serverTimestamp() });
}
