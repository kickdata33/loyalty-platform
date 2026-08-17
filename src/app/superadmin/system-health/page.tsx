"use client";

import { useCallback, useEffect, useState } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

interface HealthRow {
  component: string;
  status: "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";
  message: string | null;
}

const STATUS_COLOR: Record<HealthRow["status"], string> = {
  OK: "bg-green-100 text-green-900",
  DEGRADED: "bg-amber-100 text-amber-900",
  DOWN: "bg-red-100 text-red-900",
  UNKNOWN: "bg-slate-100 text-slate-600",
};

export default function SuperAdminSystemHealthPage() {
  const [components, setComponents] = useState<HealthRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetchJson<HealthRow[]>("/api/superadmin/system-health")
      .then(setComponents)
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "โหลดสถานะระบบไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">สถานะระบบ</h1>
      <p className="text-xs text-slate-600">
        Database และ Scheduler ตรวจสอบจริงทุก 15 นาที — component อื่นยังไม่มี metric ที่นิยามไว้ใน
        FINAL-ARCHITECTURE.md จึงแสดงเป็น &quot;UNKNOWN&quot; แทนการเดา
      </p>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      {components === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <ul className="flex flex-col gap-2">
          {components.map((c) => (
            <li key={c.component} className={`flex items-center justify-between rounded px-4 py-2 text-sm ${STATUS_COLOR[c.status]}`}>
              <span>{c.component}</span>
              <span>
                {c.status} {c.message ? `— ${c.message}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
