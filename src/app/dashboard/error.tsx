"use client";

import { useEffect } from "react";

import { StatusMessage } from "@/components/ui/StatusMessage";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="p-6">
      <StatusMessage tone="error" title="เกิดข้อผิดพลาด">
        <button type="button" onClick={reset} className="mt-2 underline">
          ลองอีกครั้ง
        </button>
      </StatusMessage>
    </main>
  );
}
