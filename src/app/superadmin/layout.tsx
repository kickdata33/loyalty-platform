"use client";

import { signOut } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { useAuth } from "@/components/auth/AuthProvider";
import { StatusMessage } from "@/components/ui/StatusMessage";
import { getFirebaseAuth } from "@/lib/firebase/client";

/**
 * Route protection for `/superadmin/*` (§37, mirrors `dashboard/layout.tsx`'s pattern exactly —
 * client-side gating is UX-only, §10; the real boundary is `requireSuperAdminAuthContext`
 * server-side on every `/api/superadmin/*` route).
 */
export default function SuperAdminLayout({ children }: { children: ReactNode }) {
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

  if (!claims?.superAdmin) {
    return (
      <main className="mx-auto flex min-h-full w-full max-w-md flex-1 flex-col justify-center gap-4 p-6">
        <StatusMessage tone="error" title="ไม่มีสิทธิ์เข้าถึงส่วนนี้">
          บัญชีนี้ไม่ใช่ Super Admin ของแพลตฟอร์ม
        </StatusMessage>
        <Link href="/dashboard" className="rounded bg-slate-900 px-4 py-2 text-center text-white">
          กลับหน้า Dashboard
        </Link>
      </main>
    );
  }

  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <nav className="flex gap-4 text-sm">
          <Link href="/superadmin">ร้านค้าทั้งหมด</Link>
          <Link href="/superadmin/packages">แพ็กเกจ</Link>
          <Link href="/superadmin/system-health">สถานะระบบ</Link>
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
