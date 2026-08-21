"use client";

import { useEffect, useRef, useState } from "react";

import { useLineClient } from "@/components/customer-portal/LineClientProviderContext";

/** Matches `CustomerPortalView` from `@/modules/customer-portal/service` — the sanitized shape
 * `/api/customer-portal/member` returns. No LINE user id, platform customer id, membershipId,
 * merchantId, or any other identity/internal field is ever present here. */
interface MemberPortalData {
  displayName: string;
  memberCode: string;
  pointsBalance: number;
  qrCodeDataUrl: string;
  joinedAt: string;
  availableRewards: Array<{ id: string; name: string; description: string; requiredPoints: number; eligible: boolean }>;
  rewards: Array<{ id: string; rewardName: string; status: "AVAILABLE" | "USED" | "EXPIRED"; redeemedAt: string; usedAt: string | null }>;
  coupons: Array<{ id: string; couponName: string; status: "AVAILABLE" | "USED" | "EXPIRED"; issuedAt: string; usedAt: string | null }>;
  pointsHistory: Array<{ id: string; type: string; delta: number; reason: string; createdAt: string }>;
}

const STATUS_LABEL: Record<"AVAILABLE" | "USED" | "EXPIRED", string> = {
  AVAILABLE: "พร้อมใช้งาน",
  USED: "ใช้แล้ว",
  EXPIRED: "หมดอายุ",
};

const POINTS_TYPE_LABEL: Record<string, string> = {
  EARN: "รับแต้ม",
  SPEND: "ใช้แต้ม",
  ADJUSTMENT: "ปรับปรุงแต้ม",
  REVERSAL: "ยกเลิกรายการ",
  EXPIRATION: "แต้มหมดอายุ",
};

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 5.5 * 60 * 1000; // slightly past the ~5-minute intent expiry

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

interface RedeemIntentState {
  rewardId: string;
  rewardName: string;
  phase: "creating" | "waiting" | "confirmed" | "error";
  intentId?: string;
  qrCodeDataUrl?: string;
  message?: string;
}

export function MemberPortalView({ data, merchantSlug, onRedeemed }: { data: MemberPortalData; merchantSlug: string; onRedeemed: () => void }) {
  const lineClient = useLineClient();
  const [intent, setIntent] = useState<RedeemIntentState | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  function stopPolling() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }

  async function handleRedeem(rewardId: string, rewardName: string) {
    stopPolling();
    setIntent({ rewardId, rewardName, phase: "creating" });
    try {
      const idToken = await lineClient.getIdToken();
      const res = await fetch("/api/customer-portal/rewards/redeem-intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchantSlug, idToken, rewardTemplateId: rewardId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setIntent({ rewardId, rewardName, phase: "error", message: body.message ?? "แลกรางวัลไม่สำเร็จ" });
        return;
      }
      const created = (await res.json()) as { intentId: string; qrCodeDataUrl: string };
      setIntent({ rewardId, rewardName, phase: "waiting", intentId: created.intentId, qrCodeDataUrl: created.qrCodeDataUrl });

      pollRef.current = setInterval(async () => {
        try {
          const freshIdToken = await lineClient.getIdToken();
          const statusRes = await fetch("/api/customer-portal/rewards/redemption-status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ merchantSlug, idToken: freshIdToken, intentId: created.intentId }),
          });
          if (!statusRes.ok) return; // transient — keep polling until timeout
          const { status } = (await statusRes.json()) as { status: string };
          if (status === "CONFIRMED") {
            stopPolling();
            setIntent({ rewardId, rewardName, phase: "confirmed" });
            onRedeemed();
          } else if (status === "EXPIRED" || status === "FAILED") {
            stopPolling();
            setIntent({
              rewardId,
              rewardName,
              phase: "error",
              message: status === "EXPIRED" ? "รหัสแลกรางวัลหมดอายุ กรุณาลองใหม่" : "แลกรางวัลไม่สำเร็จ กรุณาลองใหม่",
            });
          }
        } catch {
          // transient network hiccup — keep polling until timeout
        }
      }, POLL_INTERVAL_MS);

      timeoutRef.current = setTimeout(() => {
        stopPolling();
        setIntent((prev) => (prev && prev.phase === "waiting" ? { ...prev, phase: "error", message: "หมดเวลาแลกรางวัล กรุณาลองใหม่" } : prev));
      }, POLL_TIMEOUT_MS);
    } catch {
      setIntent({ rewardId, rewardName, phase: "error", message: "แลกรางวัลไม่สำเร็จ กรุณาลองใหม่" });
    }
  }

  function closeIntentDialog() {
    stopPolling();
    setIntent(null);
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-6 text-left">
      <div className="rounded-lg border p-4 text-center">
        <p className="text-lg font-semibold">{data.displayName}</p>
        <p className="text-xs text-slate-500">รหัสสมาชิก {data.memberCode}</p>
        <p className="mt-3 text-3xl font-bold text-[#06C755]">{data.pointsBalance.toLocaleString("th-TH")}</p>
        <p className="text-xs text-slate-500">แต้มสะสม</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- server-generated data: URL, not a static asset */}
        <img src={data.qrCodeDataUrl} alt="QR สมาชิก" className="mx-auto mt-4 h-40 w-40" />
        <p className="mt-1 text-xs text-slate-500">ให้พนักงานสแกน QR นี้เพื่อสะสม/แลกแต้ม</p>
      </div>

      {intent ? (
        <div className="rounded-lg border-2 border-[#06C755] p-4 text-center">
          <h2 className="text-sm font-medium">แลกรางวัล: {intent.rewardName}</h2>
          {intent.phase === "creating" ? <p className="mt-2 text-sm text-slate-500">กำลังสร้างรหัส…</p> : null}
          {intent.phase === "waiting" && intent.qrCodeDataUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- server-generated data: URL, not a static asset */}
              <img src={intent.qrCodeDataUrl} alt="QR แลกรางวัล" className="mx-auto mt-3 h-40 w-40" />
              <p className="mt-2 text-xs text-slate-500">ให้พนักงานสแกน QR นี้เพื่อยืนยันการแลกรางวัล (หมดอายุใน 5 นาที)</p>
              <button type="button" onClick={closeIntentDialog} className="mt-3 text-xs text-slate-500 underline">
                ยกเลิก
              </button>
            </>
          ) : null}
          {intent.phase === "confirmed" ? (
            <>
              <p className="mt-2 text-sm text-[#06C755]">แลกรางวัลสำเร็จ!</p>
              <button type="button" onClick={closeIntentDialog} className="mt-3 text-xs text-slate-500 underline">
                ปิด
              </button>
            </>
          ) : null}
          {intent.phase === "error" ? (
            <>
              <p className="mt-2 text-sm text-red-600">{intent.message}</p>
              <button type="button" onClick={closeIntentDialog} className="mt-3 text-xs text-slate-500 underline">
                ปิด
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">รางวัลที่แลกได้</h2>
        {data.availableRewards.length === 0 ? (
          <p className="text-xs text-slate-500">ยังไม่มีรางวัลให้แลกในขณะนี้</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {data.availableRewards.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 border-b pb-3 last:border-0">
                <div>
                  <p className="font-medium">{r.name}</p>
                  {r.description ? <p className="text-xs text-slate-500">{r.description}</p> : null}
                  <p className="text-xs text-slate-500">{r.requiredPoints.toLocaleString("th-TH")} แต้ม</p>
                </div>
                <button
                  type="button"
                  disabled={!r.eligible || intent?.phase === "creating" || intent?.phase === "waiting"}
                  onClick={() => handleRedeem(r.id, r.name)}
                  className="shrink-0 rounded bg-[#06C755] px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
                >
                  แลกรางวัล
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">รางวัลของฉัน</h2>
        {data.rewards.length === 0 ? (
          <p className="text-xs text-slate-500">ยังไม่มีรางวัลที่แลก</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {data.rewards.map((r) => (
              <li key={r.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                <div>
                  <p>{r.rewardName}</p>
                  <p className="text-xs text-slate-500">แลกเมื่อ {formatDate(r.redeemedAt)}</p>
                </div>
                <span className="text-xs text-slate-500">{STATUS_LABEL[r.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">คูปองของฉัน</h2>
        {data.coupons.length === 0 ? (
          <p className="text-xs text-slate-500">ยังไม่มีคูปอง</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {data.coupons.map((c) => (
              <li key={c.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                <div>
                  <p>{c.couponName}</p>
                  <p className="text-xs text-slate-500">ได้รับเมื่อ {formatDate(c.issuedAt)}</p>
                </div>
                <span className="text-xs text-slate-500">{STATUS_LABEL[c.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.pointsHistory.length > 0 ? (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">ความเคลื่อนไหวล่าสุด</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {data.pointsHistory.map((h) => (
              <li key={h.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                <div>
                  <p>{POINTS_TYPE_LABEL[h.type] ?? h.type}</p>
                  <p className="text-xs text-slate-500">
                    {h.reason || "—"} · {formatDate(h.createdAt)}
                  </p>
                </div>
                <span className={h.delta >= 0 ? "text-[#06C755]" : "text-red-600"}>
                  {h.delta >= 0 ? "+" : ""}
                  {h.delta.toLocaleString("th-TH")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
