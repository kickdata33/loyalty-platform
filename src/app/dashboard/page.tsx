"use client";

import { useEffect, useState } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

interface MerchantSummary {
  id: string;
  name: string;
  slug: string;
}

export default function DashboardHomePage() {
  const [merchant, setMerchant] = useState<MerchantSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetchJson<MerchantSummary>("/api/merchant")
      .then((data) => {
        if (!cancelled) setMerchant(data);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiClientError ? err.message : "โหลดข้อมูลร้านไม่สำเร็จ");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <StatusMessage title="กำลังโหลด…" />;
  if (error) return <StatusMessage tone="error" title={error} />;
  if (!merchant) return null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">ยินดีต้อนรับ, {merchant.name}</h1>
        <p className="text-sm text-slate-600">m/{merchant.slug}</p>
      </div>
      <StatusMessage title="ยังไม่มีข้อมูลสมาชิก แต้ม หรือกิจกรรมใดๆ">
        เริ่มต้นด้วยการเพิ่มพนักงานที่{" "}
        <a className="underline" href="/dashboard/staff">
          หน้าจัดการพนักงาน
        </a>{" "}
        หรือปรับแต่งหน้าตาร้านที่{" "}
        <a className="underline" href="/dashboard/settings">
          ตั้งค่าร้าน
        </a>
      </StatusMessage>
    </div>
  );
}
