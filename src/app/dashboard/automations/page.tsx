"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetch, apiFetchJson } from "@/lib/api/client";

/**
 * Automation/Promotion builder (§16) — ONE page/document for both, per the Architecture's own
 * "ทั้งสอง UI แก้ document เดียวกัน" principle: a "ประเภท: อัตโนมัติ / โปรโมชัน" toggle picks
 * `presentedAs`, not a separate route — implemented as a single simplified builder rather than
 * two full wizard UIs, given Phase 6's scope (raw Automation builder full; Promotion is
 * deliberately just the "Welcome" preset — MEMBER_CREATED — per the locked BIRTHDAY deferral).
 *
 * `BIRTHDAY` and `CHANGE_TIER` are never offered here — both locked Phase 6 deferrals (§16).
 */

interface AutomationRow {
  id: string;
  name: string;
  trigger: { type: string };
  actions: { type: string }[];
  presentedAs: "AUTOMATION" | "PROMOTION";
  status: string;
  lastTestRunSnapshot: { estimatedAffectedMembers: number } | null;
}

const TRIGGER_LABELS: Record<string, string> = {
  MEMBER_CREATED: "สมาชิกใหม่",
  POINTS_REACHED: "แต้มถึงเป้าหมาย",
  INACTIVE_DAYS: "ไม่มาร้านนานเกินกำหนด",
  COUPON_EXPIRING: "คูปองใกล้หมดอายุ",
  COUPON_REDEEMED: "ใช้คูปองแล้ว",
  REWARD_REDEEMED: "แลกรางวัลแล้ว",
  SCHEDULE: "ตามวันที่กำหนด",
};

const ACTION_LABELS: Record<string, string> = {
  ADD_POINTS: "เพิ่มแต้ม",
  ISSUE_COUPON: "แจกคูปอง",
  ISSUE_REWARD: "แลกรางวัลให้อัตโนมัติ",
  ADD_TAG: "ติดแท็ก",
  SEND_NOTIFICATION: "ส่งข้อความแจ้งลูกค้า (ยังใช้งานจริงไม่ได้จนกว่าจะเชื่อม LINE)",
  NOTIFY_OWNER: "แจ้งเตือนเจ้าของร้าน (ยังใช้งานจริงไม่ได้จนกว่าจะเชื่อม LINE)",
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "ฉบับร่าง",
  TEST: "ทดสอบแล้ว",
  ACTIVE: "เปิดใช้งาน",
  PAUSED: "หยุดชั่วคราว",
  ENDED: "สิ้นสุด",
};

export default function AutomationsPage() {
  const { claims } = useAuth();
  const canManage = claims?.role === "OWNER" || claims?.role === "MANAGER";

  const [automations, setAutomations] = useState<AutomationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [presentedAs, setPresentedAs] = useState<"AUTOMATION" | "PROMOTION">("AUTOMATION");
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("MEMBER_CREATED");
  const [actionType, setActionType] = useState("ADD_POINTS");
  const [actionAmount, setActionAmount] = useState("");
  const [actionCouponTemplateId, setActionCouponTemplateId] = useState("");
  const [actionRewardTemplateId, setActionRewardTemplateId] = useState("");
  const [actionTag, setActionTag] = useState("");
  const [marketingTitle, setMarketingTitle] = useState("");
  const [marketingDescription, setMarketingDescription] = useState("");
  const [maxExecPerCustomerPerDay, setMaxExecPerCustomerPerDay] = useState("");
  const [pointBudget, setPointBudget] = useState("");
  const [couponBudget, setCouponBudget] = useState("");

  const load = useCallback(() => {
    apiFetchJson<AutomationRow[]>("/api/automations")
      .then(setAutomations)
      .catch(() => setError("โหลดรายการอัตโนมัติไม่สำเร็จ"));
  }, []);

  useEffect(load, [load]);

  if (!canManage) {
    return (
      <StatusMessage tone="warning" title="คุณไม่มีสิทธิ์เข้าถึงหน้านี้">
        เฉพาะเจ้าของร้านหรือผู้จัดการเท่านั้นที่ตั้งค่าอัตโนมัติ/โปรโมชันได้
      </StatusMessage>
    );
  }

  function buildActionParams(): Record<string, unknown> {
    switch (actionType) {
      case "ADD_POINTS":
        return { amount: Number(actionAmount) };
      case "ISSUE_COUPON":
        return { couponTemplateId: actionCouponTemplateId };
      case "ISSUE_REWARD":
        return { rewardTemplateId: actionRewardTemplateId };
      case "ADD_TAG":
        return { tag: actionTag };
      default:
        return {};
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await apiFetchJson("/api/automations", {
        method: "POST",
        body: {
          name,
          presentedAs,
          trigger: { type: presentedAs === "PROMOTION" ? "MEMBER_CREATED" : triggerType, config: {} },
          conditions: [],
          actions: [{ type: actionType, params: buildActionParams() }],
          limits: {
            maxExecPerCustomerPerDay: maxExecPerCustomerPerDay.trim() === "" ? null : Number(maxExecPerCustomerPerDay),
            maxExecPerPromotion: null,
            pointBudget: pointBudget.trim() === "" ? null : Number(pointBudget),
            couponBudget: couponBudget.trim() === "" ? null : Number(couponBudget),
            cooldownHours: null,
          },
          marketing:
            presentedAs === "PROMOTION"
              ? { title: marketingTitle, description: marketingDescription, bannerImageUrl: null, visibleInCustomerPortal: false }
              : undefined,
        },
      });
      setName("");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "สร้างอัตโนมัติไม่สำเร็จ");
    }
  }

  async function handleDryRun(id: string) {
    setError(null);
    setNotice(null);
    try {
      const result = await apiFetchJson<{ estimatedAffectedMembers: number }>(`/api/automations/${id}/dry-run`, {
        method: "POST",
      });
      setNotice(`ทดสอบแล้ว: ครอบคลุมสมาชิกประมาณ ${result.estimatedAffectedMembers} คน — ตอนนี้เปิดใช้งานจริงได้แล้ว`);
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "ทดสอบไม่สำเร็จ");
    }
  }

  async function handleSetStatus(id: string, status: string) {
    setError(null);
    try {
      await apiFetch(`/api/automations/${id}/status`, { method: "PATCH", body: { status } });
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "เปลี่ยนสถานะไม่สำเร็จ");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">อัตโนมัติ / โปรโมชัน</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}
      {notice ? <StatusMessage title={notice} /> : null}

      {automations === null ? (
        <StatusMessage title="กำลังโหลด…" />
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2">ชื่อ</th>
              <th className="py-2">ประเภท</th>
              <th className="py-2">เงื่อนไข</th>
              <th className="py-2">การกระทำ</th>
              <th className="py-2">สถานะ</th>
              <th className="py-2">จัดการ</th>
            </tr>
          </thead>
          <tbody>
            {automations.map((a) => (
              <tr key={a.id} className="border-b align-top">
                <td className="py-2">{a.name}</td>
                <td className="py-2">{a.presentedAs === "PROMOTION" ? "โปรโมชัน" : "อัตโนมัติ"}</td>
                <td className="py-2">{TRIGGER_LABELS[a.trigger.type] ?? a.trigger.type}</td>
                <td className="py-2">{a.actions.map((ac) => ACTION_LABELS[ac.type] ?? ac.type).join(", ")}</td>
                <td className="py-2">{STATUS_LABELS[a.status] ?? a.status}</td>
                <td className="py-2">
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => handleDryRun(a.id)} className="rounded border px-2 py-1 text-xs">
                      ทดสอบ (Dry Run)
                    </button>
                    {a.status !== "ACTIVE" ? (
                      <button
                        type="button"
                        onClick={() => handleSetStatus(a.id, "ACTIVE")}
                        disabled={!a.lastTestRunSnapshot}
                        title={!a.lastTestRunSnapshot ? "ต้องทดสอบก่อนเปิดใช้งานจริง" : undefined}
                        className="rounded border px-2 py-1 text-xs disabled:opacity-50"
                      >
                        เปิดใช้งาน
                      </button>
                    ) : (
                      <button type="button" onClick={() => handleSetStatus(a.id, "PAUSED")} className="rounded border px-2 py-1 text-xs">
                        หยุดชั่วคราว
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded border p-4">
        <h2 className="text-sm font-medium">สร้างใหม่</h2>
        <div className="flex gap-4 text-sm">
          <label className="flex items-center gap-1">
            <input type="radio" checked={presentedAs === "AUTOMATION"} onChange={() => setPresentedAs("AUTOMATION")} />
            อัตโนมัติ (กำหนดเงื่อนไขเอง)
          </label>
          <label className="flex items-center gap-1">
            <input type="radio" checked={presentedAs === "PROMOTION"} onChange={() => setPresentedAs("PROMOTION")} />
            โปรโมชัน: ต้อนรับสมาชิกใหม่ (Welcome)
          </label>
        </div>
        <input required placeholder="ชื่อ" value={name} onChange={(e) => setName(e.target.value)} className="rounded border px-3 py-2 text-sm" />

        {presentedAs === "AUTOMATION" ? (
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            เมื่อไหร่
            <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)} className="rounded border px-3 py-2 text-sm">
              {Object.entries(TRIGGER_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <input
              placeholder="หัวข้อโปรโมชัน"
              value={marketingTitle}
              onChange={(e) => setMarketingTitle(e.target.value)}
              className="rounded border px-3 py-2 text-sm"
            />
            <input
              placeholder="รายละเอียด"
              value={marketingDescription}
              onChange={(e) => setMarketingDescription(e.target.value)}
              className="rounded border px-3 py-2 text-sm"
            />
          </>
        )}

        <label className="flex flex-col gap-1 text-xs text-slate-600">
          ทำอะไร
          <select value={actionType} onChange={(e) => setActionType(e.target.value)} className="rounded border px-3 py-2 text-sm">
            {Object.entries(ACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {actionType === "ADD_POINTS" ? (
          <input
            required
            type="number"
            min={1}
            placeholder="จำนวนแต้ม"
            value={actionAmount}
            onChange={(e) => setActionAmount(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
        ) : null}
        {actionType === "ISSUE_COUPON" ? (
          <input
            required
            placeholder="รหัสคูปอง (Coupon Template ID)"
            value={actionCouponTemplateId}
            onChange={(e) => setActionCouponTemplateId(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
        ) : null}
        {actionType === "ISSUE_REWARD" ? (
          <input
            required
            placeholder="รหัสรางวัล (Reward Template ID)"
            value={actionRewardTemplateId}
            onChange={(e) => setActionRewardTemplateId(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
        ) : null}
        {actionType === "ADD_TAG" ? (
          <input
            required
            placeholder="แท็ก"
            value={actionTag}
            onChange={(e) => setActionTag(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
          />
        ) : null}

        <div className="grid grid-cols-3 gap-2">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            จำกัดต่อคน/วัน (เว้นว่าง = ไม่จำกัด)
            <input type="number" min={0} value={maxExecPerCustomerPerDay} onChange={(e) => setMaxExecPerCustomerPerDay(e.target.value)} className="rounded border px-3 py-2 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            งบแต้มรวม (เว้นว่าง = ไม่จำกัด)
            <input type="number" min={0} value={pointBudget} onChange={(e) => setPointBudget(e.target.value)} className="rounded border px-3 py-2 text-sm" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            งบคูปองรวม (เว้นว่าง = ไม่จำกัด)
            <input type="number" min={0} value={couponBudget} onChange={(e) => setCouponBudget(e.target.value)} className="rounded border px-3 py-2 text-sm" />
          </label>
        </div>

        <button type="submit" className="w-fit rounded bg-slate-900 px-4 py-2 text-sm text-white">
          บันทึกฉบับร่าง
        </button>
        <p className="text-xs text-slate-500">สร้างแล้วต้องกด &quot;ทดสอบ (Dry Run)&quot; ก่อนจึงจะเปิดใช้งานจริงได้</p>
      </form>
    </div>
  );
}
