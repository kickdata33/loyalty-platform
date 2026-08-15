"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface StaffRow {
  id: string;
  authUid: string;
  email: string | null;
  role: "OWNER" | "MANAGER" | "STAFF";
  status: "ACTIVE" | "SUSPENDED";
}

export default function StaffManagementPage() {
  const { claims } = useAuth();
  const canManageStaff = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MANAGER" | "STAFF">("STAFF");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    apiFetchJson<StaffRow[]>("/api/staff")
      .then(setStaff)
      .catch((err: unknown) =>
        setError(err instanceof ApiClientError ? err.message : "โหลดรายชื่อพนักงานไม่สำเร็จ"),
      );
  }, []);

  useEffect(load, [load]);

  async function handleAddStaff(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      await apiFetchJson("/api/staff", { method: "POST", body: { email, role } });
      setEmail("");
      load();
    } catch (err) {
      setFormError(
        err instanceof ApiClientError ? err.message : "เพิ่มพนักงานไม่สำเร็จ",
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAction(staffUserId: string, action: "suspend" | "reinstate") {
    setError(null);
    try {
      await apiFetch(`/api/staff/${staffUserId}/${action}`, { method: "POST" });
      load();
    } catch {
      setError("ดำเนินการไม่สำเร็จ");
    }
  }

  async function handleRoleChange(staffUserId: string, newRole: "MANAGER" | "STAFF") {
    setError(null);
    try {
      await apiFetch(`/api/staff/${staffUserId}/role`, { method: "PATCH", body: { role: newRole } });
      load();
    } catch {
      setError("เปลี่ยนตำแหน่งไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">พนักงาน</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      {staff === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">อีเมล</th>
              <th className="py-2">ตำแหน่ง</th>
              <th className="py-2">สถานะ</th>
              {canManageStaff ? <th className="py-2">จัดการ</th> : null}
            </tr>
          </thead>
          <tbody>
            {staff.map((s) => (
              <tr key={s.id} className="border-b">
                <td className="py-2">{s.email ?? s.authUid}</td>
                <td className="py-2">{s.role}</td>
                <td className="py-2">{s.status === "ACTIVE" ? "ทำงานอยู่" : "ระงับใช้งาน"}</td>
                {canManageStaff ? (
                  <td className="flex gap-2 py-2">
                    {s.role !== "OWNER" && (
                      <>
                        <select
                          value={s.role}
                          onChange={(e) =>
                            handleRoleChange(s.id, e.target.value as "MANAGER" | "STAFF")
                          }
                          className="rounded border px-2 py-1 text-xs"
                        >
                          <option value="STAFF">STAFF</option>
                          <option value="MANAGER">MANAGER</option>
                        </select>
                        <button
                          type="button"
                          onClick={() =>
                            handleAction(s.id, s.status === "ACTIVE" ? "suspend" : "reinstate")
                          }
                          className="rounded border px-2 py-1 text-xs"
                        >
                          {s.status === "ACTIVE" ? "ระงับ" : "เปิดใช้งานอีกครั้ง"}
                        </button>
                      </>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canManageStaff ? (
        <form onSubmit={handleAddStaff} className="flex flex-col gap-3 rounded border p-4">
          <h2 className="text-sm font-medium">เพิ่มพนักงาน</h2>
          <p className="text-xs text-slate-600">
            พนักงานต้องสมัครสมาชิกด้วยอีเมลนี้ก่อน (ที่หน้าสมัครสมาชิก) จึงจะเพิ่มได้
          </p>
          {formError ? <StatusMessage tone="error" title={formError} /> : null}
          <div className="flex gap-2">
            <input
              type="email"
              required
              placeholder="อีเมลพนักงาน"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 rounded border px-3 py-2 text-sm"
            />
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "MANAGER" | "STAFF")}
              className="rounded border px-3 py-2 text-sm"
            >
              <option value="STAFF">STAFF</option>
              <option value="MANAGER">MANAGER</option>
            </select>
            <button
              type="submit"
              disabled={submitting}
              className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              เพิ่ม
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
