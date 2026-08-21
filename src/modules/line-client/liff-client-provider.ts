"use client";

import liff from "@line/liff";

import type { LineClientContext, LineClientProvider } from "@/modules/line-client/types";

/**
 * Real `LineClientProvider` implementation (FINAL-ARCHITECTURE.md §22 Definition of Done) — wraps
 * the `@line/liff` SDK behind the same 3-method interface the Customer Portal has depended on
 * since Phase 2's skeleton. No Customer Portal component imports `liff` directly; this is the
 * ONE file in the codebase allowed to.
 */
export class LiffClientProvider implements LineClientProvider {
  private initPromise: Promise<void> | null = null;

  constructor(private readonly liffId: string) {}

  // TEMPORARY staging-only diagnostics (see LineLoginButton for the matching removal note) —
  // step markers, booleans, and sanitized error messages only, never a token/sub/credential value.
  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = liff.init({ liffId: this.liffId }).then(
        () => {
          console.log("[liff-debug] liff.init: resolved");
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          console.log("[liff-debug] liff.init: rejected —", message);
          throw err;
        },
      );
    }
    await this.initPromise;
  }

  async login(): Promise<void> {
    await this.ensureInit();
    const isLoggedIn = liff.isLoggedIn();
    console.log("[liff-debug] liff.isLoggedIn (at login() call):", isLoggedIn);
    if (!isLoggedIn) {
      liff.login();
    }
  }

  async getIdToken(): Promise<string> {
    await this.ensureInit();
    console.log("[liff-debug] liff.isLoggedIn (at getIdToken() call):", liff.isLoggedIn());
    const idToken = liff.getIDToken();
    console.log("[liff-debug] ID token present:", Boolean(idToken));
    if (idToken) {
      const decoded = liff.getDecodedIDToken();
      console.log("[liff-debug] decoded sub present:", Boolean(decoded?.sub));
    }
    if (!idToken) {
      throw new Error("No LINE ID Token available — call login() first.");
    }
    return idToken;
  }

  async getContext(): Promise<LineClientContext> {
    await this.ensureInit();
    return { isInClient: liff.isInClient() };
  }
}
