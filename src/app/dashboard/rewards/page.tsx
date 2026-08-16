"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

interface RewardRow {
  id: string;
  name: string;
  description: string;
  type: string;
  enabled: boolean;
  requiredPoints: number;
  stock: number | null;
  limitPerMember: number | null;
}

interface BranchRow {
  id: string;
  name: string;
}

const REWARD_TYPE_LABELS: Record<string, string> = {
  FIXED_DISCOUNT: "ส่วนลดจำนวนเงิน",
  PERCENTAGE_DISCOUNT: "ส่วนลดเปอร์เซ็นต์",
  FREE_PRODUCT: "สินค้าฟรี",
  FREE_SERVICE: "บริการฟรี",
  PRIVILEGE: "สิทธิพิเศษ",
  PHYSICAL_REWARD: "ของรางวัล (จับต้องได้)",
  CUSTOM: "อื่นๆ",
};

export default function RewardsPage() {
  const { claims } = useAuth();
  const canManage = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [rewards, setRewards] = useState<RewardRow[] | null>(null);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("FIXED_DISCOUNT");
  const [requiredPoints, setRequiredPoints] = useState(100);
  const [stock, setStock] = useState(""); // empty = unlimited
  const [limitPerMember, setLimitPerMember] = useState(""); // empty = unlimited
  const [startAt, setStartAt] = useState(""); // empty = เริ่มใช้ได้ทันที
  const [endAt, setEndAt] = useState(""); // empty = ไม่มีวันสิ้นสุด
  const [expiryType, setExpiryType] = useState<"NEVER" | "DAYS_AFTER_REDEMPTION">("NEVER");
  const [expiryDays, setExpiryDays] = useState(30);
  const [selectedBranches, setSelectedBranches] = useState<string[]>([]); // empty = ทุกสาขา

  const load = useCallback(() => {
    apiFetchJson<RewardRow[]>("/api/rewards")
      .then(setRewards)
      .catch(() => setError("โหลดรายการรางวัลไม่สำเร็จ"));
    apiFetchJson<BranchRow[]>("/api/branches")
      .then(setBranches)
      .catch(() => setError("โหลดรายชื่อสาขาไม่สำเร็จ"));
  }, []);

  function toggleBranch(branchId: string) {
    setSelectedBranches((prev) =>
      prev.includes(branchId) ? prev.filter((id) => id !== branchId) : [...prev, branchId],
    );
  }

  useEffect(load, [load]);

  if (!canManage) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่ตั้งรางวัลได้
      </StatusMessage>
    );
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiFetchJson("/api/rewards", {
        method: "POST",
        body: {
          name,
          description,
          type,
          requiredPoints,
          stock: stock.trim() === "" ? undefined : Number(stock),
          limitPerMember: limitPerMember.trim() === "" ? undefined : Number(limitPerMember),
          startAt: startAt === "" ? undefined : new Date(startAt).toISOString(),
          endAt: endAt === "" ? undefined : new Date(endAt).toISOString(),
          voucherExpiryRule:
            expiryType === "NEVER" ? { type: "NEVER" } : { type: "DAYS_AFTER_REDEMPTION", days: expiryDays },
          branchScope: selectedBranches,
        },
      });
      setName("");
      setDescription("");
      setStock("");
      setLimitPerMember("");
      setStartAt("");
      setEndAt("");
      setExpiryType("NEVER");
      setExpiryDays(30);
      setSelectedBranches([]);
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "สร้างรางวัลไม่สำเร็จ");
    }
  }

  async function toggleEnabled(rewardId: string, enabled: boolean) {
    setError(null);
    try {
      await apiFetch(`/api/rewards/${rewardId}/enabled`, { method: "PATCH", body: { enabled: !enabled } });
      load();
    } catch {
      setError("แก้ไขสถานะไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">รางวัลแลกแต้ม</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}

      {rewards === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">ชื่อ</th>
              <th className="py-2">ประเภท</th>
              <th className="py-2">แต้มที่ใช้</th>
              <th className="py-2">คงเหลือ</th>
              <th className="py-2">สถานะ</th>
              <th className="py-2">จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {rewards.map((r) => (
              <tr key={r.id} className="border-b">
                <td className="py-2">{r.name}</td>
                <td className="py-2">{REWARD_TYPE_LABELS[r.type] ?? r.type}</td>
                <td className="py-2">{r.requiredPoints}</td>
                <td className="py-2">{r.stock === null ? "ไม่จำกัด" : r.stock}</td>
                <td className="py-2">{r.enabled ? "เปิดใช้งาน" : "ปิดใช้งาน"}</td>
                <td className="py-2">
                  <button
                    type="button"
                    onClick={() => toggleEnabled(r.id, r.enabled)}
                    className="rounded border px-2 py-1 text-xs"
                  >
                    {r.enabled ? "ปิดใช้งาน" : "เปิดใช้งาน"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">สร้างรางวัลใหม่</h2>
        <input
          required
          placeholder="ชื่อรางวัล"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <input
          placeholder="รายละเอียด (เช่น ส่วนลด 10% ครั้งถัดไป)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded border px-3 py-2 text-sm"
        >
          {Object.entries(REWARD_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          แต้มที่ต้องใช้แลก
          <input
            type="number"
            required
            min={1}
            value={requiredPoints}
            onChange={(e) => setRequiredPoints(Number(e.target.value))}
            className="rounded border px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          จำนวนสิทธิ์ทั้งหมด (เว้นว่าง = ไม่จำกัด)
          <input
            type="number"
            min={0}
            value={stock}
            onChange={(e) => setStock(e.target.value)}
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

        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1 text-xs text-slate-600">
            เริ่มใช้ได้ตั้งแต่ (เว้นว่าง = เริ่มใช้ได้ทันที)
            <input
              type="date"
              value={startAt}
              onChange={(e) => setStartAt(e.target.value)}
              className="rounded border px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-slate-600">
            ใช้ได้ถึงวันที่ (เว้นว่าง = ไม่มีวันสิ้นสุด)
            <input
              type="date"
              value={endAt}
              onChange={(e) => setEndAt(e.target.value)}
              className="rounded border px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="flex flex-col gap-1 text-xs text-slate-600">
          วันหมดอายุของสิทธิ์หลังแลกแล้ว
          <div className="flex items-center gap-2">
            <select
              value={expiryType}
              onChange={(e) => setExpiryType(e.target.value as "NEVER" | "DAYS_AFTER_REDEMPTION")}
              className="rounded border px-3 py-2 text-sm"
            >
              <option value="NEVER">ไม่มีวันหมดอายุ</option>
              <option value="DAYS_AFTER_REDEMPTION">หมดอายุหลังแลกกี่วัน</option>
            </select>
            {expiryType === "DAYS_AFTER_REDEMPTION" ? (
              <input
                type="number"
                min={1}
                value={expiryDays}
                onChange={(e) => setExpiryDays(Number(e.target.value))}
                className="w-24 rounded border px-3 py-2 text-sm"
              />
            ) : null}
          </div>
        </div>

        {branches.length > 0 ? (
          <div className="flex flex-col gap-1 text-xs text-slate-600">
            สาขาที่ใช้รางวัลนี้ได้ (ไม่เลือก = ทุกสาขา)
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
          สร้างรางวัล
        </button>
      </form>
    </div>
  );
}
