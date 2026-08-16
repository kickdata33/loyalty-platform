"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

/**
 * LINE connection wizard (§20) — Owner-only. Owner pastes the 5 values Step 4 requires (4
 * original + the Phase 7 V1 long-lived Messaging Access Token, per the locked "Messaging API
 * Channel Access Token" decision, §19) and presses "เชื่อมต่อ" once; the backend handles LIFF app
 * creation + webhook registration automatically. Never displays a secret/token value back.
 */
interface LineStatus {
  overallStatus: string;
  messagingChannel: { channelId: string; status: string };
  loginChannel: { channelId: string; liffId: string | null; status: string };
}

export default function LineSettingsPage() {
  const { claims } = useAuth();
  const isOwner = claims?.role === "OWNER";

  const [status, setStatus] = useState<LineStatus | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [lineProviderId, setLineProviderId] = useState("");
  const [messagingChannelId, setMessagingChannelId] = useState("");
  const [messagingChannelSecret, setMessagingChannelSecret] = useState("");
  const [messagingChannelAccessToken, setMessagingChannelAccessToken] = useState("");
  const [loginChannelId, setLoginChannelId] = useState("");
  const [loginChannelSecret, setLoginChannelSecret] = useState("");

  const load = useCallback(() => {
    apiFetchJson<LineStatus | null>("/api/line/status")
      .then(setStatus)
      .catch(() => setError("โหลดสถานะการเชื่อมต่อ LINE ไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  if (!isOwner) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านเท่านั้นที่จัดการการเชื่อมต่อ LINE ได้
      </StatusMessage>
    );
  }

  async function handleConnect(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiFetchJson("/api/line/connect", {
        method: "POST",
        body: {
          lineProviderId,
          messagingChannelId,
          messagingChannelSecret,
          messagingChannelAccessToken,
          loginChannelId,
          loginChannelSecret,
        },
      });
      setNotice("เชื่อมต่อ LINE สำเร็จ");
      setMessagingChannelSecret("");
      setMessagingChannelAccessToken("");
      setLoginChannelSecret("");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "เชื่อมต่อไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">ตั้งค่า LINE</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}
      {notice ? <StatusMessage title={notice} /> : null}

      {status === undefined ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : status ? (
        <div className="rounded border p-4 text-sm">
          <p>สถานะ: {status.overallStatus}</p>
          <p>Messaging API: {status.messagingChannel.status}</p>
          <p>LINE Login: {status.loginChannel.status}</p>
        </div>
      ) : (
        <StatusMessage title="ยังไม่ได้เชื่อมต่อ LINE" />
      )}

      <form onSubmit={handleConnect} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">เชื่อมต่อ LINE Official Account</h2>
        <p className="text-xs text-slate-500">
          คัดลอกค่าจาก LINE Developers Console มาวางที่นี่ — ระบบจะสร้าง LIFF App และตั้งค่า Webhook
          ให้อัตโนมัติเมื่อกดเชื่อมต่อ
        </p>
        <input required placeholder="LINE Provider ID" value={lineProviderId} onChange={(e) => setLineProviderId(e.target.value)} className="rounded border px-3 py-2 text-sm" />
        <input required placeholder="Messaging API Channel ID" value={messagingChannelId} onChange={(e) => setMessagingChannelId(e.target.value)} className="rounded border px-3 py-2 text-sm" />
        <input required type="password" placeholder="Messaging API Channel Secret" value={messagingChannelSecret} onChange={(e) => setMessagingChannelSecret(e.target.value)} className="rounded border px-3 py-2 text-sm" />
        <input required type="password" placeholder="Messaging API Channel Access Token (long-lived, จาก Console)" value={messagingChannelAccessToken} onChange={(e) => setMessagingChannelAccessToken(e.target.value)} className="rounded border px-3 py-2 text-sm" />
        <input required placeholder="LINE Login Channel ID" value={loginChannelId} onChange={(e) => setLoginChannelId(e.target.value)} className="rounded border px-3 py-2 text-sm" />
        <input required type="password" placeholder="LINE Login Channel Secret" value={loginChannelSecret} onChange={(e) => setLoginChannelSecret(e.target.value)} className="rounded border px-3 py-2 text-sm" />
        <button type="submit" className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
          เชื่อมต่อ
        </button>
      </form>
    </div>
  );
}
