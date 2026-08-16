"use client";

import { signOut } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { getFirebaseAuth } from "@/lib/firebase/client";

/**
 * Route protection for `/dashboard/*` happens entirely client-side (§8 Phase 2 Architecture
 * Decision: Bearer ID Token only, no session cookie — a server-rendered page has no way to know
 * who's visiting). This layout is the single gate every dashboard page sits behind:
 *
 * 1. loading  → explicit loading state, never flash protected content
 * 2. no user  → redirect to /login
 * 3. user, but no merchantId/role claim yet → not staff of any merchant, offer /onboarding
 * 4. user with claims → render the dashboard shell + children
 *
 * This is UX-only gating (§10) — the real security boundary is server-side `requireStaffAuthContext`
 * + the Authorization Service on every API route; a client bug here can hide/show UI incorrectly
 * but can never grant access to data the API wouldn't already allow.
 */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, claims, loading } = useAuth();

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

  if (!user) return null; // redirecting via the effect above

  if (!claims?.merchantId || !claims.role) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
        <StatusMessage tone="warning" title="บัญชีนี้ยังไม่ได้เชื่อมกับร้านใด">
          หากคุณเป็นเจ้าของร้าน ให้สร้างร้านใหม่ — หรือแจ้งเจ้าของร้านให้เพิ่มคุณเป็นพนักงานด้วยอีเมลนี้
        </StatusMessage>
        <Link href="/onboarding" className="rounded bg-slate-900 px-4 py-2 text-center text-white">
          สร้างร้านใหม่
        </Link>
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <nav className="flex gap-4 text-sm">
          <Link href="/dashboard">หน้าหลัก</Link>
          <Link href="/dashboard/members">สมาชิก</Link>
          <Link href="/dashboard/points-rules">กติกาแต้ม</Link>
          <Link href="/dashboard/rewards">รางวัลแลกแต้ม</Link>
          <Link href="/dashboard/coupons">คูปอง</Link>
          <Link href="/dashboard/staff">พนักงาน</Link>
          <Link href="/dashboard/settings">ตั้งค่าร้าน</Link>
        </nav>
        <button
          type="button"
          onClick={() => signOut(getFirebaseAuth())}
          className="text-sm text-slate-600 underline"
        >
          ออกจากระบบ
        </button>
      </header>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
