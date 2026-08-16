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

  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = liff.init({ liffId: this.liffId });
    }
    await this.initPromise;
  }

  async login(): Promise<void> {
    await this.ensureInit();
    if (!liff.isLoggedIn()) {
      liff.login();
    }
  }

  async getIdToken(): Promise<string> {
    await this.ensureInit();
    const idToken = liff.getIDToken();
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
