"use client";

import { useEffect, useState } from "react";

import { useLineClient } from "@/components/customer-portal/LineClientProviderContext";

/**
 * Calls `LineClientProvider.login()`/`getContext()`/`getIdToken()` exclusively through
 * `useLineClient()` — never `liff.*` directly (§22). Phase 2's stub always rejects, so this
 * honestly reports "not available yet" for merchants that haven't connected LINE.
 *
 * §20's "Customer-side" flow: `liff.login()` typically completes via a full-page redirect back
 * into this same LIFF URL — this component's mount-time effect checks whether a login already
 * completed (via `getContext()`/`getIdToken()` succeeding) and, if so, finishes the flow itself by
 * sending ONLY `{ idToken }` (§21/§22 — never a client-read profile/userId) to the backend for
 * verification.
 */
export function LineLoginButton({ merchantSlug }: { merchantSlug: string }) {
  const lineClient = useLineClient();
  const [message, setMessage] = useState<string | null>(null);
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function completeLoginIfAlreadyAuthenticated() {
      try {
        const idToken = await lineClient.getIdToken();
        if (cancelled) return;
        const res = await fetch("/api/customer-portal/line-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchantSlug, idToken }),
        });
        if (!cancelled) {
          if (res.ok) setLoggedIn(true);
          else setMessage("เข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
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

  if (loggedIn) {
    return <p className="text-sm text-slate-700">เข้าสู่ระบบแล้ว — บัตรสมาชิกของคุณพร้อมใช้งาน</p>;
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
