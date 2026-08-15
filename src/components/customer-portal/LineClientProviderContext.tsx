"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { NotImplementedLineClientProvider } from "@/modules/line-client/not-implemented-provider";
import type { LineClientProvider } from "@/modules/line-client/types";

/**
 * React boundary for `LineClientProvider` (FINAL-ARCHITECTURE.md §22). Every Customer Portal
 * component that needs LINE identity/context calls `useLineClient()` — never imports `liff`
 * directly. Swapping in the real `LiffClientProvider` in Phase 7 means changing the `provider`
 * prop passed here once, not touching any consuming component.
 */

const LineClientProviderContext = createContext<LineClientProvider | null>(null);

export function LineClientProviderRoot({
  children,
  provider,
}: {
  children: ReactNode;
  /** Defaults to the Phase 2 stub — pass a real provider once one exists (Phase 7). */
  provider?: LineClientProvider;
}) {
  const value = useMemo(() => provider ?? new NotImplementedLineClientProvider(), [provider]);
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
