"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

interface BranchRow {
  id: string;
  name: string;
  address: string;
  isActive: boolean;
}

export default function SettingsPage() {
  const { claims } = useAuth();
  const canManageBranding = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [logoUrl, setLogoUrl] = useState("");
  const [coverUrl, setCoverUrl] = useState("");
  const [primaryColor, setPrimaryColor] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [branches, setBranches] = useState<BranchRow[] | null>(null);
  const [branchName, setBranchName] = useState("");

  const loadBranches = useCallback(() => {
    apiFetchJson<BranchRow[]>("/api/branches")
      .then(setBranches)
      .catch(() => setError("โหลดรายชื่อสาขาไม่สำเร็จ"));
  }, []);

  useEffect(loadBranches, [loadBranches]);

  if (!canManageBranding) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่ตั้งค่าร้านได้
      </StatusMessage>
    );
  }

  async function handleSaveBranding(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setSubmitting(true);
    try {
      await apiFetchJson("/api/merchant/branding", {
        method: "PATCH",
        body: { logoUrl, coverUrl, primaryColor },
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddBranch(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiFetchJson("/api/branches", { method: "POST", body: { name: branchName, address: "" } });
      setBranchName("");
      loadBranches();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "เพิ่มสาขาไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">ตั้งค่าร้าน</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      <form onSubmit={handleSaveBranding} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">แบรนด์ร้าน</h2>
        <label className="flex flex-col gap-1 text-sm">
          โลโก้ (URL)
          <input
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          ภาพปก (URL)
          <input
            value={coverUrl}
            onChange={(e) => setCoverUrl(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          สีหลัก
          <input
            type="color"
            value={primaryColor || "#0f172a"}
            onChange={(e) => setPrimaryColor(e.target.value)}
            className="h-10 w-16 rounded border"
          />
        </label>
        {saved ? <StatusMessage title="บันทึกแล้ว" /> : null}
        <button
          type="submit"
          disabled={submitting}
          className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          บันทึก
        </button>
      </form>

      <div className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">สาขา</h2>
        {branches === null ? (
          <StatusMessage title="กำลังโหลด…" />
        ) : (
          <ul className="text-sm">
            {branches.map((b) => (
              <li key={b.id}>{b.name}</li>
            ))}
          </ul>
        )}
        <form onSubmit={handleAddBranch} className="flex gap-2">
          <input
            required
            placeholder="ชื่อสาขาใหม่"
            value={branchName}
            onChange={(e) => setBranchName(e.target.value)}
            className="flex-1 rounded border px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded border px-4 py-2 text-sm">
            เพิ่มสาขา
          </button>
        </form>
      </div>
    </div>
  );
}
