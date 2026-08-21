"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { QrScanner } from "@/components/dashboard/QrScanner";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

/** Matches the sanitized shape `/api/members/search` returns — no LINE user id, no platform
 * identity id, ever (see that route's `toMemberListItem`). */
interface MemberListItem {
  id: string;
  memberCode: string;
  displayName: string;
  phone: string | null;
  pointsBalance: number;
  joinedAt: string;
  lastVisitAt: string | null;
}

interface MemberListResponse {
  memberships: MemberListItem[];
  nextCursor: string | null;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

export default function MembersPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  // Guards against an in-flight fetch from a stale query landing after a newer one — same
  // cancellation pattern used elsewhere in this codebase's client effects (e.g. LineLoginButton).
  const requestId = useRef(0);

  const fetchMembers = useCallback(async (q: string) => {
    const thisRequest = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetchJson<MemberListResponse>(
        `/api/members/search?q=${encodeURIComponent(q)}`,
      );
      if (requestId.current !== thisRequest) return; // superseded by a newer request
      setMembers(data.memberships);
      setNextCursor(data.nextCursor);
    } catch (err) {
      if (requestId.current !== thisRequest) return;
      setError(err instanceof ApiClientError ? err.message : "โหลดรายชื่อสมาชิกไม่สำเร็จ");
      setMembers([]);
      setNextCursor(null);
    } finally {
      if (requestId.current === thisRequest) setLoading(false);
    }
  }, []);

  // Default view on load: the full member list (paginated), newest first — an empty query means
  // "show all members", not "show nothing". Deferred via queueMicrotask so fetchMembers' state
  // updates never run synchronously within the effect body itself (react-hooks/set-state-in-effect).
  useEffect(() => {
    queueMicrotask(() => {
      void fetchMembers("");
    });
  }, [fetchMembers]);

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    await fetchMembers(query);
  }

  async function handleLoadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const data = await apiFetchJson<MemberListResponse>(
        `/api/members/search?q=${encodeURIComponent(query)}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setMembers((prev) => [...prev, ...data.memberships]);
      setNextCursor(data.nextCursor);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "โหลดสมาชิกเพิ่มเติมไม่สำเร็จ");
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleScan(value: string) {
    setScanError(null);
    try {
      const member = await apiFetchJson<{ id: string }>(
        `/api/members/by-code/${encodeURIComponent(value)}`,
      );
      router.push(`/dashboard/members/${member.id}`);
    } catch (err) {
      setScanError(
        err instanceof ApiClientError && err.status === 404
          ? "ไม่พบสมาชิกจากรหัสนี้"
          : "สแกนไม่สำเร็จ",
      );
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">สมาชิก</h1>

      <div className="rounded border p-4">
        <h2 className="mb-2 text-sm font-medium">สแกน QR สมาชิก</h2>
        {scanError ? <StatusMessage tone="error" title={scanError} /> : null}
        <QrScanner onDecode={handleScan} />
      </div>

      <div className="rounded border p-4">
        <h2 className="mb-2 text-sm font-medium">ค้นหาสมาชิก (ชื่อ / เบอร์โทร / รหัสสมาชิก)</h2>
        <form onSubmit={handleSearch} className="flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="พิมพ์เพื่อค้นหา… (เว้นว่างเพื่อดูสมาชิกทั้งหมด)"
            className="flex-1 rounded border px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
            ค้นหา
          </button>
        </form>

        {error ? <StatusMessage tone="error" title={error} /> : null}

        {loading ? (
          <p className="mt-4 text-sm text-slate-500">กำลังโหลด…</p>
        ) : members.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">ไม่พบสมาชิก</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-xs text-slate-500">
                  <th className="py-2 pr-4">ชื่อ</th>
                  <th className="py-2 pr-4">รหัสสมาชิก</th>
                  <th className="py-2 pr-4">แต้มสะสม</th>
                  <th className="py-2 pr-4">วันที่เข้าร่วม</th>
                  <th className="py-2 pr-4">เยี่ยมชมล่าสุด</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b last:border-0">
                    <td className="py-2 pr-4">
                      <a href={`/dashboard/members/${m.id}`} className="underline">
                        {m.displayName}
                      </a>
                      {m.phone ? <span className="ml-2 text-xs text-slate-500">{m.phone}</span> : null}
                    </td>
                    <td className="py-2 pr-4">{m.memberCode}</td>
                    <td className="py-2 pr-4">{m.pointsBalance.toLocaleString("th-TH")}</td>
                    <td className="py-2 pr-4">{formatDate(m.joinedAt)}</td>
                    <td className="py-2 pr-4">{m.lastVisitAt ? formatDate(m.lastVisitAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {nextCursor ? (
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="mt-4 rounded border px-4 py-2 text-sm disabled:opacity-50"
              >
                {loadingMore ? "กำลังโหลด…" : "โหลดเพิ่มเติม"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
