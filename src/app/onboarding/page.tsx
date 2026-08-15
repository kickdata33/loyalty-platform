"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { apiFetchJson } from "@/lib/api/client";

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 50);
}

export default function OnboardingPage() {
  const router = useRouter();
  const { user, claims, loading, refreshClaims } = useAuth();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [businessType, setBusinessType] = useState("cafe");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <main className="p-6">
        <StatusMessage title="กำลังตรวจสอบสถานะการเข้าสู่ระบบ…" />
      </main>
    );
  }

  if (!user) return null; // redirecting

  if (claims?.merchantId) {
    return (
      <main className="p-6">
        <StatusMessage tone="info" title="บัญชีนี้มีร้านอยู่แล้ว">
          ไปที่ <a className="underline" href="/dashboard">Dashboard</a>
        </StatusMessage>
      </main>
    );
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetchJson("/api/merchants", {
        method: "POST",
        body: {
          name,
          slug: slug || slugify(name),
          businessType,
          timezone: "Asia/Bangkok",
        },
      });
      // Custom claims are cached client-side until the ID Token is refreshed (§8) — force a
      // refresh now so /dashboard sees the new merchantId/role claim immediately.
      await refreshClaims();
      router.push("/dashboard");
    } catch {
      setError("สร้างร้านไม่สำเร็จ — ชื่อ URL นี้อาจถูกใช้ไปแล้ว ลองเปลี่ยนดูอีกครั้ง");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-1 flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold">สร้างร้านของคุณ</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-sm">
          ชื่อร้าน
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          URL ร้าน (m/…)
          <input
            value={slug}
            placeholder={slugify(name) || "my-shop"}
            onChange={(e) => setSlug(slugify(e.target.value))}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          ประเภทธุรกิจ
          <select
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            className="rounded border px-3 py-2"
          >
            <option value="cafe">คาเฟ่ / ร้านกาแฟ</option>
            <option value="restaurant">ร้านอาหาร</option>
            <option value="salon">ร้านเสริมสวย</option>
            <option value="fitness">ฟิตเนส</option>
            <option value="other">อื่นๆ</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {submitting ? "กำลังสร้างร้าน…" : "สร้างร้าน"}
        </button>
      </form>
    </main>
  );
}
