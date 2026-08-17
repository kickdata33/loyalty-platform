"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

interface MerchantRow {
  id: string;
  name: string;
  slug: string;
  businessType: string;
  subscriptionStatus: string | null;
}

export default function SuperAdminMerchantListPage() {
  const [merchants, setMerchants] = useState<MerchantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetchJson<MerchantRow[]>("/api/superadmin/merchants")
      .then(setMerchants)
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "โหลดรายชื่อร้านค้าไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">ร้านค้าทั้งหมด</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      {merchants === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">ชื่อร้าน</th>
              <th className="py-2">Slug</th>
              <th className="py-2">ประเภทธุรกิจ</th>
              <th className="py-2">สถานะ Subscription</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {merchants.map((m) => (
              <tr key={m.id} className="border-b">
                <td className="py-2">{m.name}</td>
                <td className="py-2">{m.slug}</td>
                <td className="py-2">{m.businessType}</td>
                <td className="py-2">{m.subscriptionStatus ?? "—"}</td>
                <td className="py-2">
                  <Link href={`/superadmin/merchants/${m.id}`} className="text-slate-600 underline">
                    ดูรายละเอียด
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
