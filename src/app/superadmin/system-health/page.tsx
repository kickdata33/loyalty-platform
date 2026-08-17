"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface HealthRow {
  component: string;
  status: "OK" | "DEGRADED" | "DOWN" | "UNKNOWN";
  message: string | null;
}

interface OpsSettings {
  criticalAlertRecipient: { lineUserId: string } | null;
}

const STATUS_COLOR: Record<HealthRow["status"], string> = {
  OK: "bg-green-100 text-green-900",
  DEGRADED: "bg-amber-100 text-amber-900",
  DOWN: "bg-red-100 text-red-900",
  UNKNOWN: "bg-slate-100 text-slate-600",
};

export default function SuperAdminSystemHealthPage() {
  const [components, setComponents] = useState<HealthRow[] | null>(null);
  const [opsSettings, setOpsSettings] = useState<OpsSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lineUserId, setLineUserId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetchJson<HealthRow[]>("/api/superadmin/system-health")
      .then(setComponents)
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "โหลดสถานะระบบไม่สำเร็จ"));
    apiFetchJson<OpsSettings>("/api/superadmin/ops-settings")
      .then((s) => {
        setOpsSettings(s);
        setLineUserId(s.criticalAlertRecipient?.lineUserId ?? "");
      })
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "โหลดการตั้งค่าแจ้งเตือนไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  async function handleSaveRecipient(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length === 0) {
      setError("กรุณาระบุเหตุผลก่อนเปลี่ยนผู้รับแจ้งเตือน");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch("/api/superadmin/ops-settings", {
        method: "POST",
        body: { lineUserId: lineUserId.trim().length > 0 ? lineUserId.trim() : null, reason },
      });
      setReason("");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "บันทึกผู้รับแจ้งเตือนไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">สถานะระบบ</h1>
      <p className="text-xs text-slate-600">
        Database, Scheduler และ Balance Reconciliation ตรวจสอบจริง — component อื่นยังไม่มี metric ที่นิยามไว้ใน
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

      <section className="rounded border p-4">
        <h2 className="mb-2 text-sm font-medium">ผู้รับแจ้งเตือน Critical Error</h2>
        <p className="mb-2 text-xs text-slate-600">
          เก็บค่าไว้สำหรับอนาคตเท่านั้น — <strong>การส่งแจ้งเตือนสดผ่าน LINE ยังไม่เปิดใช้งาน</strong> (รอสถาปัตยกรรม
          LINE channel ระดับแพลตฟอร์มที่ยังไม่มีอยู่ในปัจจุบัน — ทุก LINE channel ที่มีอยู่ตอนนี้ผูกกับร้านค้าแต่ละร้าน
          เท่านั้น). ทุก error ที่กระทบ business state ยังถูกบันทึกไว้ใน Critical Error log เสมอ ไม่ว่าจะตั้งค่านี้หรือไม่
        </p>
        <form onSubmit={handleSaveRecipient} className="flex flex-col gap-2">
          <input
            type="text"
            placeholder="LINE User ID ของผู้รับ (เว้นว่างเพื่อปิด)"
            value={lineUserId}
            onChange={(e) => setLineUserId(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
          <input
            type="text"
            required
            placeholder="เหตุผลในการเปลี่ยนแปลง"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
          <button type="submit" disabled={busy} className="self-start rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
            บันทึก
          </button>
        </form>
        {opsSettings?.criticalAlertRecipient ? (
          <p className="mt-2 text-xs text-slate-600">
            ปัจจุบัน (เก็บไว้สำหรับอนาคต ยังไม่ส่งแจ้งเตือนสด): {opsSettings.criticalAlertRecipient.lineUserId}
          </p>
        ) : (
          <p className="mt-2 text-xs text-slate-600">ปัจจุบัน: ยังไม่ได้ตั้งค่า</p>
        )}
      </section>
    </div>
  );
}
