"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface MerchantDetail {
  merchant: { id: string; name: string; slug: string; businessType: string; timezone: string };
  subscription: { packageId: string | null; status: string; trialEndsAt: string | null } | null;
  staff: Array<{ id: string; authUid: string; role: string; status: string }>;
}

interface EmergencyControlState {
  staffSuspended: boolean;
  pointsEngineFrozen: boolean;
  automationDisabled: boolean;
  broadcastDisabled: boolean;
}

const CAPABILITY_LABEL: Record<keyof EmergencyControlState, string> = {
  staffSuspended: "ระงับการเข้าใช้งานของพนักงานทั้งหมด",
  pointsEngineFrozen: "หยุดระบบแต้มชั่วคราว",
  automationDisabled: "ปิดระบบอัตโนมัติ",
  broadcastDisabled: "ปิดการส่ง Broadcast",
};

export default function SuperAdminMerchantDetailPage() {
  const params = useParams<{ merchantId: string }>();
  const router = useRouter();
  const merchantId = params.merchantId;

  const [detail, setDetail] = useState<MerchantDetail | null>(null);
  const [controls, setControls] = useState<EmergencyControlState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [supportReason, setSupportReason] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    apiFetchJson<MerchantDetail>(`/api/superadmin/merchants/${merchantId}`).then(setDetail).catch(() => setError("โหลดข้อมูลร้านไม่สำเร็จ"));
    apiFetchJson<EmergencyControlState>(`/api/superadmin/emergency-controls/${merchantId}`).then(setControls).catch(() => setError("โหลด Emergency Control ไม่สำเร็จ"));
  }, [merchantId]);

  useEffect(load, [load]);

  async function toggleCapability(capability: keyof EmergencyControlState, enabled: boolean) {
    if (reason.trim().length === 0) {
      setError("กรุณาระบุเหตุผลก่อนเปลี่ยน Emergency Control");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/superadmin/emergency-controls/${merchantId}`, {
        method: "POST",
        body: { capability, enabled, reason },
      });
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "เปลี่ยน Emergency Control ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenSupportSession(event: FormEvent) {
    event.preventDefault();
    if (supportReason.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiFetchJson<{ sessionId: string }>("/api/superadmin/support-sessions", {
        method: "POST",
        body: { merchantId, reason: supportReason },
      });
      router.push(`/superadmin/merchants/${merchantId}/support?sessionId=${result.sessionId}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "เปิด Support Session ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Link href="/superadmin" className="text-sm text-slate-600 underline">
        ← กลับรายชื่อร้านค้า
      </Link>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      {detail === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <>
          <div>
            <h1 className="text-xl font-semibold">{detail.merchant.name}</h1>
            <p className="text-sm text-slate-600">
              slug: {detail.merchant.slug} · timezone: {detail.merchant.timezone}
            </p>
          </div>

          <section className="rounded border p-4">
            <h2 className="mb-2 text-sm font-medium">Subscription</h2>
            <p className="text-sm">
              สถานะ: {detail.subscription?.status ?? "—"} · Package: {detail.subscription?.packageId ?? "ไม่มี (Trial default)"}
            </p>
          </section>

          <section className="rounded border p-4">
            <h2 className="mb-2 text-sm font-medium">พนักงาน ({detail.staff.length})</h2>
            <ul className="text-sm">
              {detail.staff.map((s) => (
                <li key={s.id}>
                  {s.authUid} — {s.role} ({s.status})
                </li>
              ))}
            </ul>
          </section>

          <section className="rounded border p-4">
            <h2 className="mb-2 text-sm font-medium">Emergency Control</h2>
            <p className="mb-2 text-xs text-slate-600">ต้องระบุเหตุผลก่อนเปลี่ยนสถานะทุกครั้ง — มีการบันทึก audit log เสมอ</p>
            <input
              type="text"
              placeholder="เหตุผล"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mb-3 w-full rounded border px-3 py-2 text-sm"
            />
            {controls === null ? (
              <StatusMessage title="กำลังโหลด…" />
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {(Object.keys(CAPABILITY_LABEL) as Array<keyof EmergencyControlState>).map((cap) => (
                  <li key={cap} className="flex items-center justify-between">
                    <span>{CAPABILITY_LABEL[cap]}</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => toggleCapability(cap, !controls[cap])}
                      className={`rounded px-3 py-1 text-xs ${controls[cap] ? "bg-red-600 text-white" : "border"}`}
                    >
                      {controls[cap] ? "กำลังระงับอยู่ — กดเพื่อยกเลิก" : "ยังปกติ — กดเพื่อระงับ"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded border p-4">
            <h2 className="mb-2 text-sm font-medium">เข้าสู่ Support Mode (View-as)</h2>
            <p className="mb-2 text-xs text-slate-600">
              เข้าดูข้อมูลของร้านนี้แบบอ่านอย่างเดียว ต้องระบุเหตุผลเสมอ และหมดอายุอัตโนมัติ
            </p>
            <form onSubmit={handleOpenSupportSession} className="flex gap-2">
              <input
                type="text"
                required
                placeholder="เหตุผลในการเข้า Support Mode"
                value={supportReason}
                onChange={(e) => setSupportReason(e.target.value)}
                className="flex-1 rounded border px-3 py-2 text-sm"
              />
              <button type="submit" disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
                เข้า Support Mode
              </button>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
