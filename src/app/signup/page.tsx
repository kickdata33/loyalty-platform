"use client";

import { createUserWithEmailAndPassword } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";
import { getFirebaseAuth } from "@/lib/firebase/client";

/**
 * Creates a plain Firebase Auth account only — no merchant/StaffUser yet (§8: Staff/Owner auth is
 * Firebase Auth email/password; custom claims come later, exclusively via `onStaffUserWrite`).
 * After signup, `/dashboard` detects "no merchant claim yet" and offers `/onboarding` (become an
 * Owner) — an Owner who already knows this person's email can also add them as staff separately.
 */
export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
      return;
    }
    setSubmitting(true);
    try {
      await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
      router.push("/dashboard");
    } catch {
      setError("สมัครสมาชิกไม่สำเร็จ — อีเมลนี้อาจถูกใช้ไปแล้ว");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-sm flex-1 flex-col justify-center gap-6 p-6">
      <h1 className="text-xl font-semibold">สมัครสมาชิก</h1>
      {error ? <StatusMessage tone="error" title={error} /> : null}
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1 text-sm">
          อีเมล
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded border px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50"
        >
          {submitting ? "กำลังสมัคร…" : "สมัครสมาชิก"}
        </button>
      </form>
      <p className="text-sm text-slate-600">
        มีบัญชีอยู่แล้ว? <Link className="underline" href="/login">เข้าสู่ระบบ</Link>
      </p>
    </main>
  );
}
