import type { LineClientContext, LineClientProvider } from "@/modules/line-client/types";

/**
 * The only `LineClientProvider` implementation that exists in Phase 2.
 *
 * Every method throws (or returns an honest "not in a LINE client" context) instead of pretending
 * to authenticate a customer — Phase 2 is explicitly forbidden from faking LINE login or
 * bypassing verification just to make the UI look functional. Real LINE ID Token verification
 * (§21) and the LIFF-backed `LiffClientProvider` (§22) are Phase 7 work; until then, any Customer
 * Portal UI that calls into this provider must handle the rejection and show an honest "not
 * available yet" state.
 */
export class NotImplementedLineClientProvider implements LineClientProvider {
  async login(): Promise<void> {
    throw new Error(
      "LINE login is not implemented yet — LiffClientProvider ships in Phase 7 (FINAL-ARCHITECTURE.md §22, §33).",
    );
  }

  async getIdToken(): Promise<string> {
    throw new Error(
      "LINE login is not implemented yet — LiffClientProvider ships in Phase 7 (FINAL-ARCHITECTURE.md §22, §33).",
    );
  }

  async getContext(): Promise<LineClientContext> {
    return { isInClient: false };
  }

  async getDisplayName(): Promise<string | null> {
    return null;
  }
}
