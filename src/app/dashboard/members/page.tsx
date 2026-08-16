"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { QrScanner } from "@/components/dashboard/QrScanner";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { ApiClientError, apiFetchJson } from "@/lib/api/client";

interface MemberSearchResult {
  id: string;
  memberCode: string;
  merchantProfile: { displayName: string; phone: string | null };
  pointsBalance: number;
}

export default function MembersPage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemberSearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      const data = await apiFetchJson<MemberSearchResult[]>(
        `/api/members/search?q=${encodeURIComponent(query)}`,
      );
      setResults(data);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "ค้นหาไม่สำเร็จ");
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
            placeholder="พิมพ์เพื่อค้นหา…"
            className="flex-1 rounded border px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-sm text-white">
            ค้นหา
          </button>
        </form>
        {error ? <StatusMessage tone="error" title={error} /> : null}
        {results !== null ? (
          <ul className="mt-4 flex flex-col gap-1 text-sm">
            {results.length === 0 ? <li>ไม่พบสมาชิก</li> : null}
            {results.map((m) => (
              <li key={m.id}>
                <a href={`/dashboard/members/${m.id}`} className="underline">
                  {m.merchantProfile.displayName} — {m.memberCode} ({m.pointsBalance} แต้ม)
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
