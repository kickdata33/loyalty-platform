"use client";

/** Matches `CustomerPortalView` from `@/modules/customer-portal/service` — the sanitized shape
 * `/api/customer-portal/member` returns. No LINE user id, platform customer id, membershipId,
 * merchantId, or any other identity/internal field is ever present here. */
interface MemberPortalData {
  displayName: string;
  memberCode: string;
  pointsBalance: number;
  qrCodeDataUrl: string;
  joinedAt: string;
  rewards: Array<{ id: string; rewardName: string; status: "AVAILABLE" | "USED" | "EXPIRED"; redeemedAt: string; usedAt: string | null }>;
  coupons: Array<{ id: string; couponName: string; status: "AVAILABLE" | "USED" | "EXPIRED"; issuedAt: string; usedAt: string | null }>;
  pointsHistory: Array<{ id: string; type: string; delta: number; reason: string; createdAt: string }>;
}

const STATUS_LABEL: Record<"AVAILABLE" | "USED" | "EXPIRED", string> = {
  AVAILABLE: "พร้อมใช้งาน",
  USED: "ใช้แล้ว",
  EXPIRED: "หมดอายุ",
};

const POINTS_TYPE_LABEL: Record<string, string> = {
  EARN: "รับแต้ม",
  SPEND: "ใช้แต้ม",
  ADJUSTMENT: "ปรับปรุงแต้ม",
  REVERSAL: "ยกเลิกรายการ",
  EXPIRATION: "แต้มหมดอายุ",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

export function MemberPortalView({ data }: { data: MemberPortalData }) {
  return (
    <div className="flex w-full max-w-md flex-col gap-6 text-left">
      <div className="rounded-lg border p-4 text-center">
        <p className="text-lg font-semibold">{data.displayName}</p>
        <p className="text-xs text-slate-500">รหัสสมาชิก {data.memberCode}</p>
        <p className="mt-3 text-3xl font-bold text-[#06C755]">{data.pointsBalance.toLocaleString("th-TH")}</p>
        <p className="text-xs text-slate-500">แต้มสะสม</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- server-generated data: URL, not a static asset */}
        <img src={data.qrCodeDataUrl} alt="QR สมาชิก" className="mx-auto mt-4 h-40 w-40" />
        <p className="mt-1 text-xs text-slate-500">ให้พนักงานสแกน QR นี้เพื่อสะสม/แลกแต้ม</p>
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">รางวัลของฉัน</h2>
        {data.rewards.length === 0 ? (
          <p className="text-xs text-slate-500">ยังไม่มีรางวัลที่แลก</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {data.rewards.map((r) => (
              <li key={r.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                <div>
                  <p>{r.rewardName}</p>
                  <p className="text-xs text-slate-500">แลกเมื่อ {formatDate(r.redeemedAt)}</p>
                </div>
                <span className="text-xs text-slate-500">{STATUS_LABEL[r.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">คูปองของฉัน</h2>
        {data.coupons.length === 0 ? (
          <p className="text-xs text-slate-500">ยังไม่มีคูปอง</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {data.coupons.map((c) => (
              <li key={c.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                <div>
                  <p>{c.couponName}</p>
                  <p className="text-xs text-slate-500">ได้รับเมื่อ {formatDate(c.issuedAt)}</p>
                </div>
                <span className="text-xs text-slate-500">{STATUS_LABEL[c.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.pointsHistory.length > 0 ? (
        <div className="rounded-lg border p-4">
          <h2 className="mb-2 text-sm font-medium">ความเคลื่อนไหวล่าสุด</h2>
          <ul className="flex flex-col gap-2 text-sm">
            {data.pointsHistory.map((h) => (
              <li key={h.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                <div>
                  <p>{POINTS_TYPE_LABEL[h.type] ?? h.type}</p>
                  <p className="text-xs text-slate-500">
                    {h.reason || "—"} · {formatDate(h.createdAt)}
                  </p>
                </div>
                <span className={h.delta >= 0 ? "text-[#06C755]" : "text-red-600"}>
                  {h.delta >= 0 ? "+" : ""}
                  {h.delta.toLocaleString("th-TH")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
