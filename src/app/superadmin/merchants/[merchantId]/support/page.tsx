"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface SupportSnapshot {
  merchantId: string;
  merchant: { name: string; slug: string; businessType: string } | null;
  subscription: { packageId: string | null; status: string } | null;
  staffCount: number;
  membershipCount: number;
  recentPointsLedger: Array<{ id: string; membershipId: string; type: string; delta: number; reason: string }>;
  automations: Array<{ id: string; name: string; status: string; presentedAs: string }>;
  recentNotificationLog: Array<{ id: string; templateType: string; status: string; error: string | null }>;
}

/**
 * Support Mode "View-as" snapshot (§37.1) — read-only. Requires an active `sessionId` (query
 * param, set by the merchant detail page after opening a session) — this page never opens a
 * session itself.
 */
export default function SupportSessionSnapshotPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");

  const [snapshot, setSnapshot] = useState<SupportSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  const load = useCallback(() => {
    if (!sessionId) return;
    apiFetchJson<SupportSnapshot>(`/api/superadmin/support-sessions/${sessionId}/snapshot`)
      .then(setSnapshot)
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "โหลดข้อมูล Support Session ไม่สำเร็จ"));
  }, [sessionId]);

  useEffect(load, [load]);

  async function handleExit() {
    if (!sessionId) return;
    try {
      await apiFetch(`/api/superadmin/support-sessions/${sessionId}/close`, { method: "POST" });
    } finally {
      setClosed(true);
      router.push(`/superadmin/merchants/${snapshot?.merchantId ?? ""}`);
    }
  }

  if (!sessionId) {
    return <StatusMessage tone="error" title="ไม่มี Support Session ที่ใช้งานอยู่" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-10 flex items-center justify-between rounded bg-amber-100 px-4 py-2 text-sm text-amber-900">
        <span>🔒 กำลังอยู่ใน Support Mode — เข้าดูข้อมูลแบบอ่านอย่างเดียวเท่านั้น</span>
        <button
          type="button"
          onClick={handleExit}
          disabled={closed}
          className="rounded bg-amber-900 px-3 py-1 text-xs text-white disabled:opacity-50"
        >
          ออกจาก Support Mode
        </button>
      </div>

      {error ? <StatusMessage tone="error" title={error} /> : null}

      {snapshot === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <>
          <h1 className="text-xl font-semibold">{snapshot.merchant?.name ?? snapshot.merchantId}</h1>
          <p className="text-sm text-slate-600">
            สมาชิก {snapshot.membershipCount} คน · พนักงาน {snapshot.staffCount} คน · Subscription: {snapshot.subscription?.status ?? "—"}
          </p>

          <section className="rounded border p-4">
            <h2 className="mb-2 text-sm font-medium">รายการแต้มล่าสุด</h2>
            <ul className="text-sm">
              {snapshot.recentPointsLedger.map((entry) => (
                <li key={entry.id}>
                  {entry.type} {entry.delta > 0 ? "+" : ""}
                  {entry.delta} — {entry.reason}
                </li>
              ))}
              {snapshot.recentPointsLedger.length === 0 ? <li className="text-slate-500">ไม่มีข้อมูล</li> : null}
            </ul>
          </section>

          <section className="rounded border p-4">
            <h2 className="mb-2 text-sm font-medium">ระบบอัตโนมัติ</h2>
            <ul className="text-sm">
              {snapshot.automations.map((a) => (
                <li key={a.id}>
                  {a.name} — {a.status} ({a.presentedAs})
                </li>
              ))}
              {snapshot.automations.length === 0 ? <li className="text-slate-500">ไม่มีข้อมูล</li> : null}
            </ul>
          </section>

          <section className="rounded border p-4">
            <h2 className="mb-2 text-sm font-medium">Log การแจ้งเตือนล่าสุด</h2>
            <ul className="text-sm">
              {snapshot.recentNotificationLog.map((n) => (
                <li key={n.id}>
                  {n.templateType} — {n.status} {n.error ? `(${n.error})` : ""}
                </li>
              ))}
              {snapshot.recentNotificationLog.length === 0 ? <li className="text-slate-500">ไม่มีข้อมูล</li> : null}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
