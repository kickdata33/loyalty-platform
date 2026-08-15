import type { Timestamp } from "firebase-admin/firestore";

import type { ActorType } from "@/modules/shared/types";

/** `auditLogs/{logId}` — FINAL-ARCHITECTURE.md §5, §18. Append-only, server-only. */
export interface AuditLogEntry {
  merchantId: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  metadata?: {
    ip?: string;
    userAgent?: string;
    requestId?: string;
  };
}

export interface AuditLogRecord extends AuditLogEntry {
  id: string;
  createdAt: Timestamp;
}
