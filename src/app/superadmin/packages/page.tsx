"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface PackageRow {
  id: string;
  name: string;
  memberLimit: number;
  staffLimit: number;
  branchLimit: number;
  price: number;
  features: { automation: boolean; advancedReports: boolean; segments: boolean };
}

const EMPTY_FORM = { name: "", memberLimit: 500, staffLimit: 3, branchLimit: 1, price: 0 };

export default function SuperAdminPackagesPage() {
  const [packages, setPackages] = useState<PackageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    apiFetchJson<PackageRow[]>("/api/superadmin/packages")
      .then(setPackages)
      .catch((err: unknown) => setError(err instanceof ApiClientError ? err.message : "โหลดรายการแพ็กเกจไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch("/api/superadmin/packages", {
        method: "POST",
        body: { ...form, features: { automation: false, advancedReports: false, segments: false } },
      });
      setForm(EMPTY_FORM);
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "สร้างแพ็กเกจไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">แพ็กเกจ</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      {packages === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">ชื่อ</th>
              <th className="py-2">สมาชิก</th>
              <th className="py-2">พนักงาน</th>
              <th className="py-2">สาขา</th>
              <th className="py-2">ราคา</th>
            </tr>
          </thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id} className="border-b">
                <td className="py-2">{p.name}</td>
                <td className="py-2">{p.memberLimit}</td>
                <td className="py-2">{p.staffLimit}</td>
                <td className="py-2">{p.branchLimit}</td>
                <td className="py-2">{p.price}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">สร้างแพ็กเกจใหม่</h2>
        <input
          type="text"
          required
          placeholder="ชื่อแพ็กเกจ"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="rounded border px-3 py-2 text-sm"
        />
        <div className="flex gap-2">
          <input
            type="number"
            min={0}
            value={form.memberLimit}
            onChange={(e) => setForm({ ...form, memberLimit: Number(e.target.value) })}
            className="w-1/4 rounded border px-3 py-2 text-sm"
            aria-label="member limit"
          />
          <input
            type="number"
            min={0}
            value={form.staffLimit}
            onChange={(e) => setForm({ ...form, staffLimit: Number(e.target.value) })}
            className="w-1/4 rounded border px-3 py-2 text-sm"
            aria-label="staff limit"
          />
          <input
            type="number"
            min={0}
            value={form.branchLimit}
            onChange={(e) => setForm({ ...form, branchLimit: Number(e.target.value) })}
            className="w-1/4 rounded border px-3 py-2 text-sm"
            aria-label="branch limit"
          />
          <input
            type="number"
            min={0}
            value={form.price}
            onChange={(e) => setForm({ ...form, price: Number(e.target.value) })}
            className="w-1/4 rounded border px-3 py-2 text-sm"
            aria-label="price"
          />
        </div>
        <button type="submit" disabled={submitting} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">
          สร้าง
        </button>
      </form>
    </div>
  );
}
