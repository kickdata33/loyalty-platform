"use client";

import { useState } from "react";

import { QrScanner } from "@/components/dashboard/QrScanner";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface RedemptionIntentPreview {
  intentId: string;
  memberDisplayName: string;
  memberCode: string;
  currentPointsBalance: number;
  rewardName: string;
  requiredPoints: number;
  status: "PENDING" | "CONFIRMED" | "FAILED" | "EXPIRED";
  expiresAt: string;
}

/**
 * Staff scans a member's self-service reward-redemption QR (from the member portal — a
 * short-lived, one-time redemption intent, NOT the member's own memberCode QR handled at
 * `/dashboard/members`), reviews member/reward/points details, then explicitly confirms — the
 * only step that actually redeems the reward and deducts points, via the existing
 * `/api/rewards/redeem`-equivalent server logic (`redeemReward()`, reused unchanged).
 */
export default function RedeemScanPage() {
  const [preview, setPreview] = useState<RedemptionIntentPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmedMessage, setConfirmedMessage] = useState<string | null>(null);

  async function handleScan(intentId: string) {
    setError(null);
    setConfirmedMessage(null);
    try {
      const data = await apiFetchJson<RedemptionIntentPreview>(
        `/api/redemption-intents/${encodeURIComponent(intentId)}`,
      );
      setPreview(data);
    } catch (err) {
      setPreview(null);
      setError(
        err instanceof ApiClientError && err.status === 404
          ? "ไม่พบรหัสแลกรางวัลนี้"
          : err instanceof ApiClientError
            ? err.message
            : "สแกนไม่สำเร็จ",
      );
    }
  }

  async function handleConfirm() {
    if (!preview) return;
    setConfirming(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/redemption-intents/${encodeURIComponent(preview.intentId)}/confirm`, {
        method: "POST",
        body: {},
      });
      const result = (await res.json()) as { rewardName: string; memberDisplayName: string };
      setConfirmedMessage(`แลกรางวัล "${result.rewardName}" ให้ ${result.memberDisplayName} สำเร็จ`);
      setPreview(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "ยืนยันการแลกรางวัลไม่สำเร็จ");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">สแกนแลกรางวัล (ลูกค้าแลกเอง)</h1>

      {!preview ? (
        <div className="rounded border p-4">
          <h2 className="mb-2 text-sm font-medium">สแกน QR แลกรางวัลจากลูกค้า</h2>
          {error ? <StatusMessage tone="error" title={error} /> : null}
          {confirmedMessage ? <StatusMessage title={confirmedMessage} /> : null}
          <QrScanner onDecode={handleScan} />
        </div>
      ) : (
        <div className="rounded border p-4">
          <h2 className="mb-2 text-sm font-medium">ยืนยันการแลกรางวัล</h2>
          <dl className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">สมาชิก</dt>
              <dd>
                {preview.memberDisplayName} ({preview.memberCode})
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">รางวัล</dt>
              <dd>{preview.rewardName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">แต้มที่ใช้</dt>
              <dd>{preview.requiredPoints.toLocaleString("th-TH")}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">แต้มคงเหลือปัจจุบัน</dt>
              <dd>{preview.currentPointsBalance.toLocaleString("th-TH")}</dd>
            </div>
          </dl>
          {preview.currentPointsBalance < preview.requiredPoints ? (
            <StatusMessage tone="error" title="สมาชิกมีแต้มไม่เพียงพอ ณ ขณะนี้" />
          ) : null}
          {error ? <StatusMessage tone="error" title={error} /> : null}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={handleConfirm}
              disabled={confirming}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {confirming ? "กำลังยืนยัน…" : "ยืนยันแลกรางวัล"}
            </button>
            <button
              type="button"
              onClick={() => {
                setPreview(null);
                setError(null);
              }}
              className="rounded border px-4 py-2 text-sm"
            >
              ยกเลิก
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
