import { FieldValue, type Transaction } from "firebase-admin/firestore";

import type { DomainEventType } from "@/modules/event/types";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

/**
 * Writes `events/{eventId}` (§5, §17) in the SAME transaction as the state change it reports —
 * "atomic ป้องกัน event หายเมื่อ state เปลี่ยนแต่ event เขียนไม่สำเร็จ". Used to live privately inside
 * `points/ledger-service.ts` (Phase 3, "nothing consumes these yet so no shared module needed");
 * extracted here in Phase 4 because `reward/service.ts` needs the exact same atomic-event-write
 * primitive, and §31's own documented Project Structure already calls for a dedicated `/event`
 * module — Phase 3 took a shortcut Phase 4 now has a second caller for, so it's no longer optional
 * to share this one implementation (CLAUDE.md: "ห้ามมี logic ซ้ำสองที่").
 */
export function writeEvent(
  tx: Transaction,
  params: { merchantId: string; type: DomainEventType; membershipId: string; payload: Record<string, unknown> },
): void {
  const ref = getDb().collection(COLLECTIONS.events).doc();
  tx.create(ref, {
    merchantId: params.merchantId,
    type: params.type,
    membershipId: params.membershipId,
    payload: params.payload,
    schemaVersion: 1,
    createdAt: FieldValue.serverTimestamp(),
  });
}
