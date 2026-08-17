import type { Timestamp } from "firebase-admin/firestore";

/**
 * `systemHealth/{component}` — FINAL-ARCHITECTURE.md §30 (System Health, Phase 9 foundation).
 * `firestore.rules` allows direct `isSuperAdmin()` client reads (same pattern as
 * `merchants`/`subscriptions`, §3) — write is server-only (the scheduled self-check function).
 *
 * §30 names seven components but never defines a per-component metric/threshold for any of them.
 * Phase 9 ships the schema, the read path, and REAL self-checks only for the two components this
 * codebase already has an honest signal for (`Database`, `Scheduler`) — the rest are written as
 * `UNKNOWN` rather than a fabricated status, since inventing a metric (e.g. "LINE webhook success
 * rate") would mean inventing new counters/instrumentation nowhere specified in the architecture
 * (CLAUDE.md: "ห้ามเดา business rule ที่ไม่มี spec รองรับ"). See the Phase 9 report's "remaining known
 * limitations" for the explicit list of what's deferred. `BalanceReconciliation` is added in
 * Phase 10 (§38.4) — an eighth, real signal, not one of §30's original seven.
 */
export type SystemHealthComponent =
  | "Database"
  | "LINE"
  | "AutomationWorker"
  | "Scheduler"
  | "Reports"
  | "Authentication"
  | "ErrorJobs"
  | "BalanceReconciliation";

export const SYSTEM_HEALTH_COMPONENTS: readonly SystemHealthComponent[] = [
  "Database",
  "LINE",
  "AutomationWorker",
  "Scheduler",
  "Reports",
  "Authentication",
  "ErrorJobs",
  "BalanceReconciliation",
];

export type SystemHealthStatus = "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface SystemHealthRecord {
  component: SystemHealthComponent;
  status: SystemHealthStatus;
  message: string | null;
  lastCheckedAt: Timestamp | null;
}
