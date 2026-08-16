"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

/**
 * Template + Preview + Broadcast (§23) — Owner/Manager (`BROADCAST_SEND`). Test Send uses the
 * Owner-configured `testRecipientLineUserId` only — never resolves a real customer/staff identity
 * (locked Phase 7 "NOTIFY_OWNER Delivery & Broadcast Test Send" decision).
 */
const TEMPLATE_LABELS: Record<string, string> = {
  POINTS_EARNED: "ได้รับแต้ม",
  POINTS_USED: "ใช้แต้ม",
  REWARD_AVAILABLE: "มีรางวัลให้แลก",
  REWARD_REDEEMED: "แลกรางวัลแล้ว",
  COUPON_ISSUED: "ได้รับคูปอง",
  COUPON_EXPIRING: "คูปองใกล้หมดอายุ",
  COUPON_USED: "ใช้คูปองแล้ว",
  WELCOME_MEMBER: "ต้อนรับสมาชิกใหม่",
  PROMOTION: "โปรโมชัน",
};

const AUDIENCE_LABELS: Record<string, string> = {
  ALL: "ทุกคน",
  ACTIVE: "ใช้งานอยู่",
  AT_RISK: "เสี่ยงหาย",
  INACTIVE: "ไม่ใช้งานแล้ว",
  VIP: "VIP",
};

interface SettingsResponse {
  templates: Record<string, { enabled: boolean; body: string }>;
  testRecipientLineUserId: string | null;
}

export default function NotificationsPage() {
  const { claims } = useAuth();
  const canManage = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [templateType, setTemplateType] = useState("PROMOTION");
  const [templateBody, setTemplateBody] = useState("");
  const [templateEnabled, setTemplateEnabled] = useState(true);
  const [testRecipient, setTestRecipient] = useState("");
  const [testBody, setTestBody] = useState("");
  const [broadcastAudience, setBroadcastAudience] = useState("ALL");
  const [broadcastTemplateType, setBroadcastTemplateType] = useState("PROMOTION");

  const load = useCallback(() => {
    apiFetchJson<SettingsResponse>("/api/notifications/settings")
      .then((s) => {
        setSettings(s);
        setTestRecipient(s.testRecipientLineUserId ?? "");
      })
      .catch(() => setError("โหลดการตั้งค่าไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  if (!canManage) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่จัดการการแจ้งเตือนได้
      </StatusMessage>
    );
  }

  const previewBody = templateBody
    .replaceAll("{{memberName}}", "คุณสมชาย")
    .replaceAll("{{points}}", "100");

  async function handleSaveTemplate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiFetchJson("/api/notifications/settings", {
        method: "PATCH",
        body: {
          templates: { ...(settings?.templates ?? {}), [templateType]: { enabled: templateEnabled, body: templateBody } },
          testRecipientLineUserId: testRecipient || null,
        },
      });
      setNotice("บันทึกเทมเพลตแล้ว");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "บันทึกไม่สำเร็จ");
    }
  }

  async function handleTestSend() {
    setError(null);
    setNotice(null);
    try {
      await apiFetchJson("/api/notifications/broadcast", { method: "POST", body: { mode: "test", testBody } });
      setNotice("ส่งข้อความทดสอบแล้ว");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "ส่งทดสอบไม่สำเร็จ — ตั้งค่าเบอร์ทดสอบก่อน");
    }
  }

  async function handleBroadcast() {
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetchJson<{ sentCount: number; failedCount: number }>("/api/notifications/broadcast", {
        method: "POST",
        body: { audience: broadcastAudience, templateType: broadcastTemplateType, variables: {} },
      });
      setNotice(`ส่งแล้ว ${result.sentCount} คน (ไม่สำเร็จ ${result.failedCount} คน)`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "ส่งไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">การแจ้งเตือนและโปรโมชัน</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}
      {notice ? <StatusMessage title={notice} /> : null}

      <form onSubmit={handleSaveTemplate} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">เทมเพลตข้อความ</h2>
        <select value={templateType} onChange={(e) => setTemplateType(e.target.value)} className="rounded border px-3 py-2 text-sm">
          {Object.entries(TEMPLATE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <textarea
          placeholder="ข้อความ (ใช้ {{memberName}}, {{points}} ได้)"
          value={templateBody}
          onChange={(e) => setTemplateBody(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
          rows={3}
        />
        <div className="rounded border border-dashed p-2 text-xs text-slate-600">ตัวอย่าง: {previewBody || "—"}</div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={templateEnabled} onChange={(e) => setTemplateEnabled(e.target.checked)} />
          เปิดใช้งานเทมเพลตนี้
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          เบอร์ LINE สำหรับทดสอบ (Owner กรอกเอง)
          <input value={testRecipient} onChange={(e) => setTestRecipient(e.target.value)} placeholder="LINE userId สำหรับทดสอบ" className="rounded border px-3 py-2 text-sm" />
        </label>
        <button type="submit" className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
          บันทึกเทมเพลต
        </button>
      </form>

      <div className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">ทดสอบส่งข้อความ</h2>
        <input value={testBody} onChange={(e) => setTestBody(e.target.value)} placeholder="ข้อความทดสอบ" className="rounded border px-3 py-2 text-sm" />
        <button type="button" onClick={handleTestSend} className="w-fit rounded border px-4 py-2 text-sm">
          ส่งทดสอบ
        </button>
      </div>

      <div className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">ส่งโปรโมชัน (Broadcast)</h2>
        <select value={broadcastAudience} onChange={(e) => setBroadcastAudience(e.target.value)} className="rounded border px-3 py-2 text-sm">
          {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select value={broadcastTemplateType} onChange={(e) => setBroadcastTemplateType(e.target.value)} className="rounded border px-3 py-2 text-sm">
          {Object.entries(TEMPLATE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" onClick={handleBroadcast} className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
          ส่งเลย
        </button>
      </div>
    </div>
  );
}
