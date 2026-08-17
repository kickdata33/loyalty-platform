"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

/**
 * Report Settings (§24 "Report Settings Schema Location", Phase 8 Locked) — Owner/Manager only
 * (`MERCHANT_SETTINGS_MANAGE`, §9). No LINE delivery toggle in V1 — Dashboard-only (§24 "Report
 * Delivery Channel Scope", Phase 8 Locked; LINE stays deferred alongside NOTIFY_OWNER). Self-
 * Service Priority Rule (CLAUDE.md/§0): plain Thai labels, no "webhook"/"trigger"/technical terms.
 */
type DailyItem = "NEW_MEMBERS" | "ACTIVE" | "POINTS" | "REWARDS" | "COUPONS" | "STAFF_ACTIVITY";
type WeeklyItem = "GROWTH" | "RETURNING" | "AT_RISK" | "INACTIVE" | "PROMOTION_PERFORMANCE";
type MonthlyItem = "MEMBERSHIP_GROWTH" | "RETENTION" | "REWARD_COUPON_PERFORMANCE" | "STAFF_SUMMARY";

const DAILY_ITEM_LABELS: Record<DailyItem, string> = {
  NEW_MEMBERS: "สมาชิกใหม่",
  ACTIVE: "สมาชิกที่ใช้งานอยู่",
  POINTS: "แต้มที่ได้รับ/ใช้ไป",
  REWARDS: "การแลกรางวัล",
  COUPONS: "การใช้คูปอง",
  STAFF_ACTIVITY: "กิจกรรมพนักงาน",
};
const WEEKLY_ITEM_LABELS: Record<WeeklyItem, string> = {
  GROWTH: "การเติบโตของสมาชิก",
  RETURNING: "สมาชิกที่กลับมาใช้ซ้ำ",
  AT_RISK: "สมาชิกที่เสี่ยงหาย",
  INACTIVE: "สมาชิกที่ไม่ใช้งานแล้ว",
  PROMOTION_PERFORMANCE: "ผลของโปรโมชัน",
};
const MONTHLY_ITEM_LABELS: Record<MonthlyItem, string> = {
  MEMBERSHIP_GROWTH: "การเติบโตของสมาชิก",
  RETENTION: "อัตราการรักษาสมาชิก",
  REWARD_COUPON_PERFORMANCE: "ผลของรางวัลและคูปอง",
  STAFF_SUMMARY: "สรุปกิจกรรมพนักงาน",
};

interface ReportSettings {
  dailyEnabled: boolean;
  weeklyEnabled: boolean;
  monthlyEnabled: boolean;
  dailyItems: DailyItem[];
  weeklyItems: WeeklyItem[];
  monthlyItems: MonthlyItem[];
}

function toggleItem<T extends string>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((i) => i !== item) : [...list, item];
}

export default function ReportSettingsPage() {
  const { claims } = useAuth();
  const canManage = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [settings, setSettings] = useState<ReportSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => {
    apiFetchJson<ReportSettings>("/api/report-settings")
      .then(setSettings)
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "โหลดการตั้งค่าไม่สำเร็จ"));
  }, []);

  useEffect(() => {
    if (canManage) load();
  }, [canManage, load]);

  if (!canManage) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่ตั้งค่ารายงานได้
      </StatusMessage>
    );
  }

  if (!settings) {
    return <StatusMessage title="กำลังโหลด…" />;
  }

  async function handleSave(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setError(null);
    setSaved(false);
    try {
      await apiFetchJson("/api/report-settings", { method: "PUT", body: settings });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "บันทึกไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">ตั้งค่ารายงาน</h1>
      <p className="text-sm text-slate-600">
        เลือกรายงานที่ต้องการรับ — รายงานจะแสดงในหน้า &quot;รายงาน&quot; ของแดชบอร์ดเมื่อถึงรอบ (ยังไม่รองรับส่งผ่าน LINE ในตอนนี้)
      </p>
      {error ? <StatusMessage tone="error" title={error} /> : null}
      {saved ? <StatusMessage title="บันทึกแล้ว" /> : null}

      <form onSubmit={handleSave} className="flex flex-col gap-6">
        <fieldset className="flex flex-col gap-2 rounded border p-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={settings.dailyEnabled}
              onChange={(e) => setSettings({ ...settings, dailyEnabled: e.target.checked })}
            />
            รายงานรายวัน
          </label>
          <div className="grid grid-cols-2 gap-1 pl-6 sm:grid-cols-3">
            {(Object.keys(DAILY_ITEM_LABELS) as DailyItem[]).map((item) => (
              <label key={item} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={settings.dailyItems.includes(item)}
                  onChange={() => setSettings({ ...settings, dailyItems: toggleItem(settings.dailyItems, item) })}
                />
                {DAILY_ITEM_LABELS[item]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded border p-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={settings.weeklyEnabled}
              onChange={(e) => setSettings({ ...settings, weeklyEnabled: e.target.checked })}
            />
            รายงานรายสัปดาห์
          </label>
          <div className="grid grid-cols-2 gap-1 pl-6 sm:grid-cols-3">
            {(Object.keys(WEEKLY_ITEM_LABELS) as WeeklyItem[]).map((item) => (
              <label key={item} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={settings.weeklyItems.includes(item)}
                  onChange={() => setSettings({ ...settings, weeklyItems: toggleItem(settings.weeklyItems, item) })}
                />
                {WEEKLY_ITEM_LABELS[item]}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2 rounded border p-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={settings.monthlyEnabled}
              onChange={(e) => setSettings({ ...settings, monthlyEnabled: e.target.checked })}
            />
            รายงานรายเดือน
          </label>
          <div className="grid grid-cols-2 gap-1 pl-6 sm:grid-cols-3">
            {(Object.keys(MONTHLY_ITEM_LABELS) as MonthlyItem[]).map((item) => (
              <label key={item} className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={settings.monthlyItems.includes(item)}
                  onChange={() => setSettings({ ...settings, monthlyItems: toggleItem(settings.monthlyItems, item) })}
                />
                {MONTHLY_ITEM_LABELS[item]}
              </label>
            ))}
          </div>
        </fieldset>

        <button type="submit" className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
          บันทึก
        </button>
      </form>
    </div>
  );
}
