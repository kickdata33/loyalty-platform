import { FieldValue } from "firebase-admin/firestore";

import type { AuditLogEntry } from "@/modules/audit/types";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

/**
 * Writes an append-only audit log entry (FINAL-ARCHITECTURE.md §18).
 *
 * Server-side only — `firestore.rules` denies all client read/write on `auditLogs`. There is no
 * `updateAuditLog`/`deleteAuditLog` function anywhere in this codebase, on purpose: "ไม่มี
 * update/delete แม้แต่จาก Super Admin ผ่าน Dashboard" (§18). If an audit entry is ever wrong, the
 * fix is a new corrective entry, never a mutation of the old one.
 *
 * Callers should await this alongside (not instead of) the business-state write it documents —
 * Phase 1 has no writes that need the same-transaction atomicity that `pointsLedger`/`events`
 * will require from Phase 3 onward (§17), so a best-effort sequential write is sufficient here.
 */
export async function writeAuditLog(entry: AuditLogEntry): Promise<string> {
  const ref = getDb().collection(COLLECTIONS.auditLogs).doc();
  await ref.set({
    ...entry,
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}
