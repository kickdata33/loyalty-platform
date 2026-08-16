"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

interface MemberDetail {
  id: string;
  memberCode: string;
  merchantProfile: { displayName: string; phone: string | null };
  pointsBalance: number;
  qrCodeDataUrl: string;
}

interface LedgerEntry {
  id: string;
  type: string;
  delta: number;
  reason: string;
  createdAt: unknown;
}

export default function MemberDetailPage() {
  const params = useParams<{ membershipId: string }>();
  const membershipId = params.membershipId;
  const { claims } = useAuth();
  const canAdjust = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [member, setMember] = useState<MemberDetail | null>(null);
  const [history, setHistory] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetchJson<MemberDetail>(`/api/members/${membershipId}`)
      .then(setMember)
      .catch(() => setError("โหลดข้อมูลสมาชิกไม่สำเร็จ"));
    apiFetchJson<LedgerEntry[]>(`/api/points/history?membershipId=${membershipId}`)
      .then(setHistory)
      .catch(() => setError("โหลดประวัติแต้มไม่สำเร็จ"));
  }, [membershipId]);

  useEffect(load, [load]);

  async function withNotice(action: () => Promise<unknown>, success: string) {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(success);
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "ดำเนินการไม่สำเร็จ");
    }
  }

  async function handleEarnVisit(event: FormEvent) {
    event.preventDefault();
    await withNotice(
      () =>
        apiFetchJson("/api/points/earn", {
          method: "POST",
          body: {
            membershipId,
            sourceType: "PER_VISIT",
            visitSource: "STAFF_SEARCH",
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      "เพิ่มแต้มตามกติกาเรียบร้อย",
    );
  }

  async function handleManualAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await withNotice(
      () =>
        apiFetchJson("/api/points/manual-add", {
          method: "POST",
          body: {
            membershipId,
            amount: Number(form.get("amount")),
            reason: String(form.get("reason") ?? ""),
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      "เพิ่มแต้มด้วยตนเองเรียบร้อย",
    );
    event.currentTarget.reset();
  }

  async function handleAdjust(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await withNotice(
      () =>
        apiFetchJson("/api/points/adjust", {
          method: "POST",
          body: {
            membershipId,
            delta: Number(form.get("delta")),
            reason: String(form.get("reason") ?? ""),
            idempotencyKey: crypto.randomUUID(),
          },
        }),
      "ปรับแต้มเรียบร้อย",
    );
    event.currentTarget.reset();
  }

  async function handleReverse(ledgerEntryId: string) {
    const reason = window.prompt("เหตุผลในการยกเลิกรายการนี้:");
    if (!reason) return;
    await withNotice(
      () =>
        apiFetchJson("/api/points/reverse", {
          method: "POST",
          body: { ledgerEntryId, reason, idempotencyKey: crypto.randomUUID() },
        }),
      "ยกเลิกรายการเรียบร้อย",
    );
  }

  if (!member) return <StatusMessage title="กำลังโหลด…" />;

  return (
    <div className="flex flex-col gap-8">
      {error ? <StatusMessage tone="error" title={error} /> : null}
      {notice ? <StatusMessage title={notice} /> : null}

      <div className="flex items-center gap-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, not a static asset */}
        <img src={member.qrCodeDataUrl} alt="QR สมาชิก" className="h-32 w-32" />
        <div>
          <h1 className="text-xl font-semibold">{member.merchantProfile.displayName}</h1>
          <p className="text-sm text-slate-600">รหัสสมาชิก: {member.memberCode}</p>
          <p className="text-2xl font-bold">{member.pointsBalance} แต้ม</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-6">
        <form onSubmit={handleEarnVisit} className="flex flex-col gap-2 rounded border p-4">
          <h2 className="text-sm font-medium">เพิ่มแต้มตามกติกา (มาเยือนร้าน)</h2>
          <button type="submit" className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
            เพิ่มแต้ม
          </button>
        </form>

        <form onSubmit={handleManualAdd} className="flex flex-col gap-2 rounded border p-4">
          <h2 className="text-sm font-medium">เพิ่มแต้มด้วยตนเอง</h2>
          <input name="amount" type="number" required placeholder="จำนวนแต้ม" className="rounded border px-3 py-2 text-sm" />
          <input name="reason" required placeholder="เหตุผล" className="rounded border px-3 py-2 text-sm" />
          <button type="submit" className="w-fit rounded border px-4 py-2 text-sm">
            เพิ่มแต้ม
          </button>
        </form>

        {canAdjust ? (
          <form onSubmit={handleAdjust} className="flex flex-col gap-2 rounded border p-4">
            <h2 className="text-sm font-medium">ปรับแต้ม (Owner/Manager)</h2>
            <input
              name="delta"
              type="number"
              required
              placeholder="จำนวน (ติดลบเพื่อหัก)"
              className="rounded border px-3 py-2 text-sm"
            />
            <input name="reason" required placeholder="เหตุผล" className="rounded border px-3 py-2 text-sm" />
            <button type="submit" className="w-fit rounded border px-4 py-2 text-sm">
              ปรับแต้ม
            </button>
          </form>
        ) : null}
      </div>

      <div>
        <h2 className="mb-2 text-sm font-medium">ประวัติแต้ม</h2>
        {history === null ? (
          <StatusMessage title="กำลังโหลด…" />
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b">
                <th className="py-2">ประเภท</th>
                <th className="py-2">จำนวน</th>
                <th className="py-2">เหตุผล</th>
                {canAdjust ? <th className="py-2">จัดการ</th> : null}
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b">
                  <td className="py-2">{h.type}</td>
                  <td className="py-2">{h.delta > 0 ? `+${h.delta}` : h.delta}</td>
                  <td className="py-2">{h.reason}</td>
                  {canAdjust ? (
                    <td className="py-2">
                      {h.type === "EARN" || h.type === "SPEND" ? (
                        <button
                          type="button"
                          onClick={() => handleReverse(h.id)}
                          className="rounded border px-2 py-1 text-xs"
                        >
                          ยกเลิกรายการนี้
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
