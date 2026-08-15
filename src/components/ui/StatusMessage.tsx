import type { ReactNode } from "react";

/** Minimal reusable banner for loading/unauthorized/forbidden/not-found/error states across the
 * app — kept intentionally plain (no new UI dependency) for Phase 2 scope. */
export function StatusMessage({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "error" | "warning";
  title: string;
  children?: ReactNode;
}) {
  const toneClass =
    tone === "error"
      ? "border-red-300 bg-red-50 text-red-900"
      : tone === "warning"
        ? "border-amber-300 bg-amber-50 text-amber-900"
        : "border-slate-300 bg-slate-50 text-slate-900";

  return (
    <div className={`rounded-lg border p-4 text-sm ${toneClass}`} role="status">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm opacity-90">{children}</div> : null}
    </div>
  );
}
