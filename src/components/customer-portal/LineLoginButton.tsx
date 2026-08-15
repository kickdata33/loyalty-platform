"use client";

import { useState } from "react";

import { useLineClient } from "@/components/customer-portal/LineClientProviderContext";

/**
 * Calls `LineClientProvider.login()` exclusively through `useLineClient()` — never `liff.*`
 * directly (§22). Phase 2's provider always rejects (see `NotImplementedLineClientProvider`), so
 * this honestly reports "not available yet" rather than faking a successful login.
 */
export function LineLoginButton() {
  const lineClient = useLineClient();
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setMessage(null);
    try {
      await lineClient.login();
    } catch {
      setMessage("การเข้าสู่ระบบด้วย LINE ยังไม่เปิดให้ใช้งานในขณะนี้");
    }
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
