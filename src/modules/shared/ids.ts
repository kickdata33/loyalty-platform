import { getDb } from "@/modules/shared/firestore";

/**
 * Generates a new document id in the given top-level collection using Firestore's own auto-id
 * generator (non-sequential, unguessable — FINAL-ARCHITECTURE.md §3: "ใช้ Firestore auto-id หรือ
 * ULID ไม่ใช้ sequential id"). No separate ULID dependency is needed since Firestore already
 * provides a suitable random id generator for free.
 */
export function newId(collection: string): string {
  return getDb().collection(collection).doc().id;
}
