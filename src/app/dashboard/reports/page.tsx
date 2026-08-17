"use client";

import { useCallback, useEffect, useState } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

/**
 * Report History (§24, Phase 8) — Owner/Manager only (`REPORT_VIEW`, §9: Staff "ห้ามดู Management
 * Reports"). Read-only list + detail — reports are generated server-side only (scheduled Cloud
 * Function), never created/edited from this page. Loyalty metrics only — no revenue/sales figure
 * appears anywhere on this page (§0, §24).
 */
type ReportType = "daily" | "weekly" | "monthly";

interface ReportMetrics {
  membersTotal: number;
  membersNew: number;
  membersActive: number;
  membersReturning: number;
  membersAtRisk: number;
  membersInactive: number;
  membersVip: number;
  pointsEarned: number;
  pointsRedeemed: number;
  rewardsRedeemed: number;
  rewardsUsed: number;
  couponsIssued: number;
  couponsUsed: number;
}

interface ReportRecord {
  id: string;
  type: ReportType;
  periodStart: string;
  periodEnd: string;
  snapshotData: ReportMetrics;
  generatedAt: string;
}

const TYPE_LABELS: Record<ReportType, string> = { daily: "รายวัน", weekly: "รายสัปดาห์", monthly: "รายเดือน" };

const METRIC_LABELS: Record<keyof ReportMetrics, string> = {
  membersTotal: "สมาชิกทั้งหมด",
  membersNew: "สมาชิกใหม่",
  membersActive: "ใช้งานอยู่",
  membersReturning: "กลับมาใช้ซ้ำ",
  membersAtRisk: "เสี่ยงหาย",
  membersInactive: "ไม่ใช้งานแล้ว",
  membersVip: "VIP",
  pointsEarned: "แต้มที่ได้รับ",
  pointsRedeemed: "แต้มที่ใช้ไป",
  rewardsRedeemed: "แลกรางวัล",
  rewardsUsed: "ใช้รางวัลแล้ว",
  couponsIssued: "แจกคูปอง",
  couponsUsed: "ใช้คูปองแล้ว",
};

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export default function ReportsPage() {
  const { claims } = useAuth();
  const canView = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [reports, setReports] = useState<ReportRecord[]>([]);
  const [selected, setSelected] = useState<ReportRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<ReportType | "">("");

  const load = useCallback(() => {
    const query = typeFilter ? `?type=${typeFilter}` : "";
    apiFetchJson<{ reports: ReportRecord[] }>(`/api/reports${query}`)
      .then((res) => setReports(res.reports))
      .catch((err) => setError(err instanceof ApiClientError ? err.message : "โหลดรายงานไม่สำเร็จ"));
  }, [typeFilter]);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  if (!canView) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่ดูรายงานได้
      </StatusMessage>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">รายงาน</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      <select
        value={typeFilter}
        onChange={(e) => setTypeFilter(e.target.value as ReportType | "")}
        className="w-fit rounded border px-3 py-2 text-sm"
      >
        <option value="">ทุกประเภท</option>
        <option value="daily">รายวัน</option>
        <option value="weekly">รายสัปดาห์</option>
        <option value="monthly">รายเดือน</option>
      </select>

      {reports.length === 0 ? (
        <StatusMessage title="ยังไม่มีรายงาน">รายงานจะถูกสร้างอัตโนมัติตามความถี่ที่ตั้งค่าไว้ (ตั้งค่าได้ที่หน้าตั้งค่ารายงาน)</StatusMessage>
      ) : (
        <div className="flex flex-col gap-2">
          {reports.map((report) => (
            <button
              key={report.id}
              type="button"
              onClick={() => setSelected(report)}
              className="flex items-center justify-between rounded border p-3 text-left text-sm hover:bg-slate-50"
            >
              <span>
                {TYPE_LABELS[report.type]} — {formatDate(report.periodStart)} ถึง {formatDate(report.periodEnd)}
              </span>
              <span className="text-xs text-slate-500">สร้างเมื่อ {formatDate(report.generatedAt)}</span>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <div className="flex flex-col gap-3 rounded border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">
              {TYPE_LABELS[selected.type]} — {formatDate(selected.periodStart)} ถึง {formatDate(selected.periodEnd)}
            </h2>
            <button type="button" onClick={() => setSelected(null)} className="text-xs text-slate-500 underline">
              ปิด
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {(Object.keys(METRIC_LABELS) as (keyof ReportMetrics)[]).map((key) => (
              <div key={key} className="rounded border p-3">
                <p className="text-xs text-slate-500">{METRIC_LABELS[key]}</p>
                <p className="text-lg font-semibold">{selected.snapshotData[key]}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
