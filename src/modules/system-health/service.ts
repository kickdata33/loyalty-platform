import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { SYSTEM_HEALTH_COMPONENTS, type SystemHealthRecord } from "@/modules/system-health/types";

/** Reads the current snapshot for every named component (§30, §37 note, §38.4) — missing
 * documents (a component no scheduled job has run for yet) are returned as `UNKNOWN` rather than
 * omitted, so the UI always shows all eight components. Takes no `SuperAdminAuthContext` — gated
 * entirely by the caller (`/api/superadmin/system-health` calls `requireSuperAdminAuthContext`
 * first). */
export async function getSystemHealth(): Promise<SystemHealthRecord[]> {
  const db = getDb();
  const snaps = await Promise.all(
    SYSTEM_HEALTH_COMPONENTS.map((component) => db.collection(COLLECTIONS.systemHealth).doc(component).get()),
  );
  return snaps.map((snap, i) => {
    const component = SYSTEM_HEALTH_COMPONENTS[i];
    if (!snap.exists) return { component, status: "UNKNOWN", message: "No self-check has run yet.", lastCheckedAt: null };
    return { component, ...(snap.data() as Omit<SystemHealthRecord, "component">) };
  });
}
