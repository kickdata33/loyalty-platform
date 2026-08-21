"use client";

import { useEffect, useState } from "react";

import { useLineClient } from "@/components/customer-portal/LineClientProviderContext";
import { MemberPortalView } from "@/components/customer-portal/MemberPortalView";

/** Matches `CustomerPortalView` from `@/modules/customer-portal/service` (the sanitized shape
 * `/api/customer-portal/member` returns) — kept as a local type rather than importing the
 * server-only module's type into client code. */
interface MemberPortalData {
  displayName: string;
  memberCode: string;
  pointsBalance: number;
  qrCodeDataUrl: string;
  joinedAt: string;
  rewards: Array<{ id: string; rewardName: string; status: "AVAILABLE" | "USED" | "EXPIRED"; redeemedAt: string; usedAt: string | null }>;
  coupons: Array<{ id: string; couponName: string; status: "AVAILABLE" | "USED" | "EXPIRED"; issuedAt: string; usedAt: string | null }>;
  pointsHistory: Array<{ id: string; type: string; delta: number; reason: string; createdAt: string }>;
}

/**
 * Calls `LineClientProvider.login()`/`getContext()`/`getIdToken()`/`getDisplayName()` exclusively
 * through `useLineClient()` — never `liff.*` directly (§22). Phase 2's stub always rejects, so
 * this honestly reports "not available yet" for merchants that haven't connected LINE.
 *
 * §20's "Customer-side" flow: `liff.login()` typically completes via a full-page redirect back
 * into this same LIFF URL — this component's mount-time effect checks whether a login already
 * completed (via `getIdToken()` succeeding) and, if so, finishes the flow itself by sending
 * `{ idToken, displayName }` (§21/§22 — `idToken` is the only trusted identity source; `displayName`
 * is cosmetic-only, never used for identity) to the backend for verification, then fetches the
 * member's own portal view (member card/QR/points/rewards/coupons) via the SAME verified idToken.
 */
export function LineLoginButton({ merchantSlug }: { merchantSlug: string }) {
  const lineClient = useLineClient();
  const [message, setMessage] = useState<string | null>(null);
  const [portalData, setPortalData] = useState<MemberPortalData | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function completeLoginIfAlreadyAuthenticated() {
      try {
        const idToken = await lineClient.getIdToken();
        if (cancelled) return;
        // Cosmetic only (§21) — getDisplayName() never throws and is never used for identity;
        // the backend still resolves/verifies identity solely from idToken's sub claim.
        const displayName = await lineClient.getDisplayName();
        if (cancelled) return;
        const loginRes = await fetch("/api/customer-portal/line-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchantSlug, idToken, displayName: displayName ?? undefined }),
        });
        if (cancelled) return;
        if (!loginRes.ok) {
          setMessage("เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
          return;
        }
        const memberRes = await fetch("/api/customer-portal/member", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchantSlug, idToken }),
        });
        if (cancelled) return;
        if (memberRes.ok) {
          setPortalData((await memberRes.json()) as MemberPortalData);
        } else {
          setMessage("โหลดข้อมูลสมาชิกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
        }
      } catch {
        // Not logged in yet, or provider not implemented — normal pre-login state, no message.
      }
    }
    void completeLoginIfAlreadyAuthenticated();
    return () => {
      cancelled = true;
    };
  }, [lineClient, merchantSlug]);

  async function handleClick() {
    setMessage(null);
    try {
      await lineClient.login();
    } catch {
      setMessage("การเข้าสู่ระบบด้วย LINE ยังไม่เปิดให้ใช้งานในขณะนี้");
    }
  }

  if (portalData) {
    return <MemberPortalView data={portalData} />;
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={handleClick}
        className="rounded bg-[#06C755] px-6 py-2 text-sm font-medium text-white"
      >
        เข้าสู่ระบบด้วย LINE
      </button>
      {message ? <p className="text-xs text-slate-500">{message}</p> : null}
    </div>
  );
}
