"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface RuleRow {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

export default function PointsRulesPage() {
  const { claims } = useAuth();
  const canManage = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"PER_VISIT" | "PER_UNIT">("PER_VISIT");
  const [pointsPerVisit, setPointsPerVisit] = useState(10);

  const load = useCallback(() => {
    apiFetchJson<RuleRow[]>("/api/points-rules")
      .then(setRules)
      .catch(() => setError("โหลดกติกาแต้มไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  if (!canManage) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่ตั้งกติกาแต้มได้
      </StatusMessage>
    );
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const config = type === "PER_VISIT" ? { pointsPerVisit } : { unit: "HOUR", pointsPerUnit: pointsPerVisit };
      await apiFetchJson("/api/points-rules", { method: "POST", body: { name, type, config } });
      setName("");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "สร้างกติกาไม่สำเร็จ");
    }
  }

  async function toggleEnabled(ruleId: string, enabled: boolean) {
    setError(null);
    try {
      await apiFetch(`/api/points-rules/${ruleId}/enabled`, { method: "PATCH", body: { enabled: !enabled } });
      load();
    } catch {
      setError("แก้ไขสถานะไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">กติกาแต้ม</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      {rules === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">ชื่อ</th>
              <th className="py-2">ประเภท</th>
              <th className="py-2">สถานะ</th>
              <th className="py-2">จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="py-2">{r.name}</td>
                <td className="py-2">{r.type}</td>
                <td className="py-2">{r.enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}</td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => toggleEnabled(r.id, r.enabled)}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    {r.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">สร้างกติกาใหม่</h2>
        <input
          required
          placeholder="ชื่อกติกา"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "PER_VISIT" | "PER_UNIT")}
          className="rounded border px-3 py-2 text-sm"
        >
          <option value="PER_VISIT">ให้แต้มต่อการมาเยือน 1 ครั้ง</option>
          <option value="PER_UNIT">ให้แต้มต่อชั่วโมง</option>
        </select>
        <input
          type="number"
          required
          min={1}
          value={pointsPerVisit}
          onChange={(e) => setPointsPerVisit(Number(e.target.value))}
          className="rounded border px-3 py-2 text-sm"
        />
        <button type="submit" className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
          สร้างกติกา
        </button>
      </form>
    </div>
  );
}
