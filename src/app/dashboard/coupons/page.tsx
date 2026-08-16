"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface CouponRow {
  id: string;
  name: string;
  description: string;
  type: string;
  enabled: boolean;
  conditions: {
    totalLimit: number | null;
    limitPerMember: number | null;
    branchScope: string[];
  };
}

interface BranchRow {
  id: string;
  name: string;
}

const COUPON_TYPE_LABELS: Record<string, string> = {
  PERCENTAGE_DISCOUNT: "ส่วนลดเปอร์เซ็นต์",
  FIXED_DISCOUNT: "ส่วนลดจำนวนเงิน",
  FREE_PRODUCT: "สินค้าฟรี",
  FREE_SERVICE: "บริการฟรี",
  BUY_X_GET_Y: "ซื้อ X แถม Y",
  PRIVILEGE: "สิทธิพิเศษ",
  CUSTOM: "อื่นๆ",
};

const SEGMENT_LABELS: Record<string, string> = {
  NEW: "สมาชิกใหม่",
  ACTIVE: "ใช้งานอยู่",
  REGULAR: "ลูกค้าประจำ",
  VIP: "VIP",
  AT_RISK: "เสี่ยงหาย",
  INACTIVE: "ไม่ใช้งานแล้ว",
};

export default function CouponsPage() {
  const { claims } = useAuth();
  const canManage = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [coupons, setCoupons] = useState<CouponRow[] | null>(null);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("FIXED_DISCOUNT");
  const [totalLimit, setTotalLimit] = useState(""); // empty = unlimited
  const [limitPerMember, setLimitPerMember] = useState(""); // empty = unlimited
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]); // empty = ทุกสาขา

  const [segmentByTemplate, setSegmentByTemplate] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    apiFetchJson<CouponRow[]>("/api/coupons")
      .then(setCoupons)
      .catch(() => setError("โหลดรายการคูปองไม่สำเร็จ"));
    apiFetchJson<BranchRow[]>("/api/branches")
      .then(setBranches)
      .catch(() => setError("โหลดรายชื่อสาขาไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  function toggleBranch(branchId: string) {
    setSelectedBranches((prev) =>
      prev.includes(branchId) ? prev.filter((id) => id !== branchId) : [...prev, branchId],
    );
  }

  if (!canManage) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่ตั้งคูปองได้
      </StatusMessage>
    );
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiFetchJson("/api/coupons", {
        method: "POST",
        body: {
          name,
          description,
          type,
          totalLimit: totalLimit.trim() === "" ? undefined : Number(totalLimit),
          limitPerMember: limitPerMember.trim() === "" ? undefined : Number(limitPerMember),
          branchScope: selectedBranches,
        },
      });
      setName("");
      setDescription("");
      setTotalLimit("");
      setLimitPerMember("");
      setSelectedBranches([]);
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "สร้างคูปองไม่สำเร็จ");
    }
  }

  async function toggleEnabled(couponId: string, enabled: boolean) {
    setError(null);
    try {
      await apiFetch(`/api/coupons/${couponId}/enabled`, { method: "PATCH", body: { enabled: !enabled } });
      load();
    } catch {
      setError("แก้ไขสถานะไม่สำเร็จ");
    }
  }

  async function handleIssueToSegment(couponTemplateId: string) {
    const targetSegment = segmentByTemplate[couponTemplateId];
    if (!targetSegment) return;
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetchJson<{ issuedCount: number; skippedCount: number }>(
        "/api/coupons/issue-segment",
        {
          method: "POST",
          body: { couponTemplateId, targetSegment, idempotencyKey: crypto.randomUUID() },
        },
      );
      setNotice(`แจกคูปองให้สมาชิกกลุ่มนี้แล้ว ${result.issuedCount} คน (ข้าม ${result.skippedCount} คนที่ครบสิทธิ์แล้ว)`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "แจกคูปองไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">คูปอง</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}
      {notice ? <StatusMessage title={notice} /> : null}

      {coupons === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">ชื่อ</th>
              <th className="py-2">ประเภท</th>
              <th className="py-2">สถานะ</th>
              <th className="py-2">จัดการ</th>
              <th className="py-2">แจกให้กลุ่มสมาชิก</th>
            </tr>
          </thead>
          <tbody>
            {coupons.map((c) => (
              <tr key={c.id} className="border-b">
                <td className="py-2">{c.name}</td>
                <td className="py-2">{COUPON_TYPE_LABELS[c.type] ?? c.type}</td>
                <td className="py-2">{c.enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}</td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => toggleEnabled(c.id, c.enabled)}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    {c.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                  </button>
                </td>
                <td className="py-2">
                  <div className="flex items-center gap-2">
                    <select
                      value={segmentByTemplate[c.id] ?? ""}
                      onChange={(e) => setSegmentByTemplate((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      className="rounded border px-2 py-1 text-xs"
                    >
                      <option value="">เลือกกลุ่ม…</option>
                      {Object.entries(SEGMENT_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => handleIssueToSegment(c.id)}
                      disabled={!segmentByTemplate[c.id]}
                      className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                    >
                      แจก
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">สร้างคูปองใหม่</h2>
        <input
          required
          placeholder="ชื่อคูปอง"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <input
          placeholder="รายละเอียด (เช่น ลด 50 บาท เมื่อซื้อครบ 300 บาท)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded border px-3 py-2 text-sm">
          {Object.entries(COUPON_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          จำนวนคูปองทั้งหมด (เว้นว่าง = ไม่จำกัด)
          <input
            type="number"
            min={0}
            value={totalLimit}
            onChange={(e) => setTotalLimit(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          จำกัดต่อสมาชิก (เว้นว่าง = ไม่จำกัด)
          <input
            type="number"
            min={1}
            value={limitPerMember}
            onChange={(e) => setLimitPerMember(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
        </label>
        {branches.length > 0 ? (
          <div className="flex flex-col gap-1 text-xs text-slate-600">
            สาขาที่ใช้คูปองนี้ได้ (ไม่เลือก = ทุกสาขา)
            <div className="flex flex-wrap gap-3">
              {branches.map((b) => (
                <label key={b.id} className="flex items-center gap-1 text-sm text-slate-900">
                  <input
                    type="checkbox"
                    checked={selectedBranches.includes(b.id)}
                    onChange={() => toggleBranch(b.id)}
                  />
                  {b.name}
                </label>
              ))}
            </div>
          </div>
        ) : null}
        <button type="submit" className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
          สร้างคูปอง
        </button>
      </form>
    </div>
  );
}
