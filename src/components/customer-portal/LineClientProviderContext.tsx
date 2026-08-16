"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { NotImplementedLineClientProvider } from "@/modules/line-client/not-implemented-provider";
import { LiffClientProvider } from "@/modules/line-client/liff-client-provider";
import type { LineClientProvider } from "@/modules/line-client/types";

/**
 * React boundary for `LineClientProvider` (FINAL-ARCHITECTURE.md §22). Every Customer Portal
 * component that needs LINE identity/context calls `useLineClient()` — never imports `liff`
 * directly.
 *
 * Takes `liffId` (a plain string, safe to pass down from a Server Component prop) rather than a
 * pre-constructed provider instance — `LiffClientProvider`/`@line/liff` must never be imported
 * anywhere reachable from server-rendered code (the LIFF SDK assumes a browser environment); this
 * component is the ONE place that decides real-vs-stub, entirely client-side.
 */

const LineClientProviderContext = createContext<LineClientProvider | null>(null);

export function LineClientProviderRoot({ children, liffId }: { children: ReactNode; liffId?: string | null }) {
  const value = useMemo<LineClientProvider>(
    () => (liffId ? new LiffClientProvider(liffId) : new NotImplementedLineClientProvider()),
    [liffId],
  );
  return (
    <LineClientProviderContext.Provider value={value}>
      {children}
    </LineClientProviderContext.Provider>
  );
}

export function useLineClient(): LineClientProvider {
  const provider = useContext(LineClientProviderContext);
  if (!provider) {
    throw new Error("useLineClient() must be used within a <LineClientProviderRoot>.");
  }
  return provider;
}
