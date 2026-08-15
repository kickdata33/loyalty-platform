import { afterEach, describe, expect, it, vi } from "vitest";

const FIREBASE_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const;

describe("firebase client config validation", () => {
  afterEach(() => {
    for (const key of FIREBASE_ENV_KEYS) delete process.env[key];
    vi.resetModules();
  });

  it("throws a clear error when required env vars are missing", async () => {
    const { getFirebaseApp } = await import("@/lib/firebase/client");
    expect(() => getFirebaseApp()).toThrow(/Missing required env var/);
  });

  it("does not throw at import time (lazy init)", async () => {
    await expect(import("@/lib/firebase/client")).resolves.toBeDefined();
  });
});
