import { beforeEach, describe, expect, it } from "vitest";

import {
  connectLineChannel,
  getLineChannelStatus,
  resolveMerchantIdFromWebhookDestination,
  verifyWebhookSignature,
  type LineProvisioningClient,
} from "@/modules/line-channel/service";
import { AuthorizationError } from "@/modules/shared/errors";
import { InMemorySecretStore, setSecretStoreForTesting } from "@/modules/shared/secret-store";

import { addStaffFixture, createMerchantFixture, uniqueId } from "./setup";

/**
 * `lineChannelConfigs` connection wizard (§19, §20, §26) — RBAC (Owner-only per §9's "ห้ามจัดการ
 * LINE credentials" for Manager), tenant isolation, and the secret-handling discipline (never a
 * raw secret/token value returned by any read path). Real LINE HTTP calls (LIFF app creation,
 * webhook registration) are stubbed via a fake `LineProvisioningClient` — this suite exercises
 * the orchestration/security logic, not LINE's own APIs (§35's spike already validated those
 * against a real account, separately, outside the automated suite).
 */
const fakeClient: LineProvisioningClient = {
  issueLoginToken: async () => "fake-login-access-token",
  createLiffApp: async () => "1234567890-fakeliff",
  setWebhookEndpoint: async () => undefined,
  getBotUserId: async () => "Ubotuserid1234567890",
};

beforeEach(() => {
  setSecretStoreForTesting(new InMemorySecretStore());
});

const validInput = {
  lineProviderId: "provider-1",
  messagingChannelId: "msg-channel-1",
  messagingChannelSecret: "msg-secret-1",
  messagingChannelAccessToken: "msg-access-token-1",
  loginChannelId: "login-channel-1",
  loginChannelSecret: "login-secret-1",
};

describe("connectLineChannel — RBAC + tenant isolation + secret handling", () => {
  it("Staff and Manager (no LINE_CONNECTION_MANAGE — Owner-only per §9) are rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    await expect(connectLineChannel(staff.ctx, validInput, "https://example.test")).rejects.toThrow(AuthorizationError);
    await expect(connectLineChannel(manager.ctx, validInput, "https://example.test")).rejects.toThrow(AuthorizationError);
  });

  it("Owner can connect; status reads back CONNECTED with no raw secret/token exposed", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const config = await connectLineChannel(ownerCtx, validInput, "https://example.test", fakeClient);
    expect(config.overallStatus).toBe("CONNECTED");
    expect(config.loginChannel.liffId).toBe("1234567890-fakeliff");
    expect(config.messagingChannel.botUserId).toBe("Ubotuserid1234567890");

    const status = await getLineChannelStatus(ownerCtx);
    expect(status?.overallStatus).toBe("CONNECTED");
    // Never the raw secret — always masked.
    expect(status?.messagingChannel.channelSecretRef).toBe("***");
    expect(status?.messagingChannel.accessTokenRef).toBe("***");
  });

  it("rejects an incomplete submission (missing field) without partial writes", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      connectLineChannel(ownerCtx, { ...validInput, loginChannelSecret: "" }, "https://example.test", fakeClient),
    ).rejects.toThrow();
    const status = await getLineChannelStatus(ownerCtx);
    expect(status).toBeNull();
  });

  it("a different merchant's Owner cannot read another merchant's LINE status (tenant isolation)", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    await connectLineChannel(merchantA.ownerCtx, validInput, "https://example.test", fakeClient);

    const statusB = await getLineChannelStatus(merchantB.ownerCtx);
    expect(statusB).toBeNull(); // merchant B has its own (empty) config, never merchant A's
  });
});

describe("verifyWebhookSignature — HMAC verification", () => {
  it("accepts a correctly signed body and rejects a tampered one", async () => {
    const { createHmac } = await import("node:crypto");
    const secret = "webhook-secret";
    const body = '{"events":[]}';
    const validSig = createHmac("sha256", secret).update(body).digest("base64");

    expect(verifyWebhookSignature(body, validSig, secret)).toBe(true);
    expect(verifyWebhookSignature(body, "tampered-signature==", secret)).toBe(false);
    expect(verifyWebhookSignature(body, null, secret)).toBe(false);
    expect(verifyWebhookSignature('{"events":[{"tampered":true}]}', validSig, secret)).toBe(false);
  });
});

describe("resolveMerchantIdFromWebhookDestination — tenant resolution by bot userId, never channelId", () => {
  it("resolves the correct merchant by botUserId and never matches on channelId alone", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    // Unique per test — NOT the shared top-of-file `fakeClient`/`validInput`. This query scans
    // `lineChannelConfigs` across every merchant this emulator run has ever connected (the
    // `connectLineChannel` describe block above connects several more with the exact same fixed
    // fake value), so reusing that fixed botUserId here would non-deterministically resolve to
    // whichever merchant happened to connect with it first, not necessarily this test's own
    // merchant — a pre-existing test-isolation bug, not a production `resolveMerchantIdFrom-
    // WebhookDestination` defect (real LINE botUserIds are unique per channel by construction).
    const uniqueBotUserId = uniqueId("Ubotuserid");
    const uniqueInput = { ...validInput, messagingChannelId: uniqueId("msg-channel") };
    const scopedFakeClient: LineProvisioningClient = { ...fakeClient, getBotUserId: async () => uniqueBotUserId };
    await connectLineChannel(ownerCtx, uniqueInput, "https://example.test", scopedFakeClient);

    const resolved = await resolveMerchantIdFromWebhookDestination(uniqueBotUserId);
    expect(resolved).toBe(merchantId);

    const notFound = await resolveMerchantIdFromWebhookDestination(uniqueInput.messagingChannelId);
    expect(notFound).toBeNull(); // channelId is NOT destination — must not accidentally match
  });
});
