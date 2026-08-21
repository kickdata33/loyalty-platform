import { describe, expect, it, vi } from "vitest";

import {
  LIFF_REQUIRED_SCOPE,
  resolveLiffApp,
  type LiffAppSummary,
  type LineProvisioningClient,
} from "@/modules/line-channel/service";

/**
 * Regression coverage for the missing-`openid`-scope bug (staging: `liff.isLoggedIn()` was true
 * but `liff.getIDToken()` returned null, because the registered LIFF app's scope came back exactly
 * `["profile", "chat_message.write"]` — LINE's default when `scope` is omitted from the create
 * request, which is exactly what the old code did). `resolveLiffApp` is the extracted, injectable
 * orchestration `connectLineChannel()` now uses instead of calling `client.createLiffApp()`
 * directly — tested here in isolation, no Firestore/RBAC/secrets involved.
 */

const ENDPOINT_URL = "https://loyalty-platform--loyalty-platform-staging-01.asia-southeast1.hosted.app/m/staging-test-shop";
const TOKEN = "fake-login-access-token";

function fakeClient(overrides: Partial<LineProvisioningClient>): LineProvisioningClient {
  return {
    issueLoginToken: vi.fn(),
    listLiffApps: vi.fn().mockResolvedValue([]),
    createLiffApp: vi.fn(),
    updateLiffAppScope: vi.fn(),
    setWebhookEndpoint: vi.fn(),
    getBotUserId: vi.fn(),
    ...overrides,
  } as LineProvisioningClient;
}

describe("LIFF_REQUIRED_SCOPE", () => {
  it("includes openid (ID token) and profile (cosmetic getProfile() display name) — nothing else unused by this codebase", () => {
    expect(LIFF_REQUIRED_SCOPE).toContain("openid");
    expect(LIFF_REQUIRED_SCOPE).toContain("profile");
    // LINE's own default scope also includes chat_message.write — deliberately excluded, since no
    // code path calls liff.sendMessages().
    expect(LIFF_REQUIRED_SCOPE).not.toContain("chat_message.write");
    expect(LIFF_REQUIRED_SCOPE).not.toContain("email");
  });
});

describe("resolveLiffApp()", () => {
  it("no existing app for this endpoint: creates one, and the create request includes openid", async () => {
    const createLiffApp = vi.fn().mockResolvedValue("new-liff-id");
    const client = fakeClient({ listLiffApps: vi.fn().mockResolvedValue([]), createLiffApp });

    const liffId = await resolveLiffApp(client, TOKEN, ENDPOINT_URL, LIFF_REQUIRED_SCOPE);

    expect(createLiffApp).toHaveBeenCalledTimes(1);
    expect(createLiffApp).toHaveBeenCalledWith(TOKEN, ENDPOINT_URL, LIFF_REQUIRED_SCOPE);
    const [, , requestedScope] = createLiffApp.mock.calls[0] as [string, string, readonly string[]];
    expect(requestedScope).toContain("openid");
    expect(liffId).toBe("new-liff-id");
  });

  it("existing app matches endpoint but is missing openid (the exact staging bug): updates in place, does NOT create a duplicate", async () => {
    const existing: LiffAppSummary = {
      liffId: "2011129100-QQVzQBiA",
      endpointUrl: ENDPOINT_URL,
      scope: ["profile", "chat_message.write"], // LINE's default when scope was omitted
    };
    const createLiffApp = vi.fn();
    const updateLiffAppScope = vi.fn().mockResolvedValue(undefined);
    const client = fakeClient({
      listLiffApps: vi.fn().mockResolvedValue([existing]),
      createLiffApp,
      updateLiffAppScope,
    });

    const liffId = await resolveLiffApp(client, TOKEN, ENDPOINT_URL, LIFF_REQUIRED_SCOPE);

    expect(createLiffApp).not.toHaveBeenCalled(); // never a duplicate
    expect(updateLiffAppScope).toHaveBeenCalledTimes(1);
    expect(updateLiffAppScope).toHaveBeenCalledWith(TOKEN, existing.liffId, LIFF_REQUIRED_SCOPE);
    const [, , updatedScope] = updateLiffAppScope.mock.calls[0] as [string, string, readonly string[]];
    expect(updatedScope).toContain("openid");
    expect(liffId).toBe(existing.liffId); // reuses the existing app's id, doesn't invent a new one
  });

  it("existing app already has exactly the required scope: fully idempotent no-op (no create, no update)", async () => {
    const existing: LiffAppSummary = {
      liffId: "2011129100-QQVzQBiA",
      endpointUrl: ENDPOINT_URL,
      scope: [...LIFF_REQUIRED_SCOPE],
    };
    const createLiffApp = vi.fn();
    const updateLiffAppScope = vi.fn();
    const client = fakeClient({
      listLiffApps: vi.fn().mockResolvedValue([existing]),
      createLiffApp,
      updateLiffAppScope,
    });

    const liffId = await resolveLiffApp(client, TOKEN, ENDPOINT_URL, LIFF_REQUIRED_SCOPE);

    expect(createLiffApp).not.toHaveBeenCalled();
    expect(updateLiffAppScope).not.toHaveBeenCalled();
    expect(liffId).toBe(existing.liffId);
  });

  it("an app registered for a DIFFERENT endpoint is never matched or touched", async () => {
    const otherApp: LiffAppSummary = {
      liffId: "some-other-merchant-liff",
      endpointUrl: "https://loyalty-platform--loyalty-platform-staging-01.asia-southeast1.hosted.app/m/a-different-shop",
      scope: ["openid"],
    };
    const createLiffApp = vi.fn().mockResolvedValue("new-liff-id");
    const updateLiffAppScope = vi.fn();
    const client = fakeClient({
      listLiffApps: vi.fn().mockResolvedValue([otherApp]),
      createLiffApp,
      updateLiffAppScope,
    });

    const liffId = await resolveLiffApp(client, TOKEN, ENDPOINT_URL, LIFF_REQUIRED_SCOPE);

    expect(updateLiffAppScope).not.toHaveBeenCalled();
    expect(createLiffApp).toHaveBeenCalledWith(TOKEN, ENDPOINT_URL, LIFF_REQUIRED_SCOPE);
    expect(liffId).toBe("new-liff-id");
  });
});
