import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { POST as postWebhook } from "@/app/api/webhooks/line/route";
import { connectLineChannel, type LineProvisioningClient } from "@/modules/line-channel/service";
import { InMemorySecretStore, setSecretStoreForTesting } from "@/modules/shared/secret-store";

import { createMerchantFixture, uniqueId } from "./setup";

/**
 * Central LINE webhook receiver (§19, §26) — signature verification, `destination`-based tenant
 * resolution, and idempotent event receipt, invoking the real exported Route Handler directly
 * (same precedent as `api-auth-transport.test.ts`) rather than a dev server.
 *
 * Every test uses its own unique `botUserId` (never a fixed constant) — Firestore data persists
 * across tests within one emulator run (only the secret store resets per test), so a fixed
 * `botUserId` shared by every test would let `resolveMerchantIdFromWebhookDestination`'s
 * `.limit(1)` query ambiguously match an EARLIER test's already-connected merchant instead of the
 * current test's own — the same "every test gets its own randomized ids" discipline already
 * documented in `./setup.ts`.
 */
function fakeClientWithBot(botUserId: string): LineProvisioningClient {
  return {
    issueLoginToken: async () => "fake-login-access-token",
    createLiffApp: async () => "fake-liff-id",
    setWebhookEndpoint: async () => undefined,
    getBotUserId: async () => botUserId,
  };
}

function connectedInput(messagingChannelSecret: string) {
  return {
    lineProviderId: uniqueId("provider"),
    messagingChannelId: uniqueId("msg-channel"),
    messagingChannelSecret,
    messagingChannelAccessToken: uniqueId("msg-access-token"),
    loginChannelId: uniqueId("login-channel"),
    loginChannelSecret: uniqueId("login-secret"),
  };
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

beforeEach(() => {
  setSecretStoreForTesting(new InMemorySecretStore());
});

describe("POST /api/webhooks/line — signature verification, tenant resolution, idempotency", () => {
  it("rejects a request with a missing signature", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const botUserId = uniqueId("Ubot");
    const secret = "webhook-test-secret-1";
    await connectLineChannel(ownerCtx, connectedInput(secret), "https://example.test", fakeClientWithBot(botUserId));

    const body = JSON.stringify({ destination: botUserId, events: [] });
    const res = await postWebhook(new Request("http://localhost/api/webhooks/line", { method: "POST", body }));
    expect(res.status).toBe(401);
  });

  it("rejects a tampered signature", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const botUserId = uniqueId("Ubot");
    const secret = "webhook-test-secret-2";
    await connectLineChannel(ownerCtx, connectedInput(secret), "https://example.test", fakeClientWithBot(botUserId));

    const body = JSON.stringify({ destination: botUserId, events: [] });
    const res = await postWebhook(
      new Request("http://localhost/api/webhooks/line", {
        method: "POST",
        body,
        headers: { "x-line-signature": "not-the-real-signature==" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects an unknown destination (no matching merchant) without leaking anything", async () => {
    const body = JSON.stringify({ destination: uniqueId("Uunknown"), events: [] });
    const res = await postWebhook(
      new Request("http://localhost/api/webhooks/line", {
        method: "POST",
        body,
        headers: { "x-line-signature": sign(body, "irrelevant-since-merchant-not-found") },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("accepts a correctly signed request for the correct merchant, and never leaks into another merchant's tenant", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    const botA = uniqueId("UbotA");
    const botB = uniqueId("UbotB");
    const secretA = "webhook-secret-a";
    const secretB = "webhook-secret-b";
    await connectLineChannel(merchantA.ownerCtx, connectedInput(secretA), "https://example.test", fakeClientWithBot(botA));
    await connectLineChannel(merchantB.ownerCtx, connectedInput(secretB), "https://example.test", fakeClientWithBot(botB));

    const body = JSON.stringify({ destination: botA, events: [{ webhookEventId: uniqueId("evt"), type: "follow" }] });
    const res = await postWebhook(
      new Request("http://localhost/api/webhooks/line", {
        method: "POST",
        body,
        headers: { "x-line-signature": sign(body, secretA) },
      }),
    );
    expect(res.status).toBe(200);

    // Merchant B's secret must NOT validate a signature meant for merchant A's payload.
    const crossTenantSig = sign(body, secretB);
    const crossRes = await postWebhook(
      new Request("http://localhost/api/webhooks/line", {
        method: "POST",
        body,
        headers: { "x-line-signature": crossTenantSig },
      }),
    );
    expect(crossRes.status).toBe(401); // destination=botA resolves to merchant A, whose secret != secretB
  });

  it("a replayed webhookEventId is idempotently accepted (no error) on retry", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const botUserId = uniqueId("Ubot");
    const secret = "webhook-test-secret-3";
    await connectLineChannel(ownerCtx, connectedInput(secret), "https://example.test", fakeClientWithBot(botUserId));

    const body = JSON.stringify({ destination: botUserId, events: [{ webhookEventId: uniqueId("evt-replay"), type: "follow" }] });
    const signature = sign(body, secret);

    const first = await postWebhook(new Request("http://localhost/api/webhooks/line", { method: "POST", body, headers: { "x-line-signature": signature } }));
    const second = await postWebhook(new Request("http://localhost/api/webhooks/line", { method: "POST", body, headers: { "x-line-signature": signature } }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // LINE's own retry — must not error
  });
});
