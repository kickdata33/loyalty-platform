import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import type { LineChannelConfig } from "@/modules/line-channel/types";
import { getMerchantRecordOrThrow } from "@/modules/merchant/service";
import { requireOwner } from "@/modules/rbac/authorization-service";
import { NotFoundError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import { getSecretStore } from "@/modules/shared/secret-store";
import type { AuthContext } from "@/modules/shared/types";

/**
 * `lineChannelConfigs` service (FINAL-ARCHITECTURE.md §19, §20, §26) — the merchant LINE
 * connection wizard's backend, and the credential-resolution layer the webhook receiver /
 * `LineAdapter` both depend on.
 *
 * Owner-only throughout (`requireOwner` — §9 "ห้ามจัดการ LINE credentials" for Manager). Never
 * returns a raw secret/token value to any caller outside this module — API routes surface only
 * `overallStatus`/per-channel `status`.
 */

const LINE_TOKEN_ENDPOINT = "https://api.line.me/oauth2/v3/token";
const LIFF_APPS_ENDPOINT = "https://api.line.me/liff/v1/apps";
const MESSAGING_WEBHOOK_ENDPOINT_URL = "https://api.line.me/v2/bot/channel/webhook/endpoint";
const BOT_INFO_ENDPOINT = "https://api.line.me/v2/bot/info";

export interface ConnectLineChannelInput {
  lineProviderId: string;
  messagingChannelId: string;
  messagingChannelSecret: string;
  /** V1: Console-issued long-lived token (locked Phase 7 decision) — pasted once by Owner. */
  messagingChannelAccessToken: string;
  loginChannelId: string;
  loginChannelSecret: string;
}

/** Injectable seam for the real outbound LINE calls this function makes (LIFF app creation,
 * webhook URL registration) — production uses the real `fetch`-backed default; emulator tests
 * inject a fake so the RBAC/tenant-isolation/secret-handling orchestration below is fully testable
 * without ever calling out to LINE (matches `verifyLineIdToken`'s `fetchImpl` pattern). */
export interface LineProvisioningClient {
  issueLoginToken(channelId: string, channelSecret: string): Promise<string>;
  createLiffApp(loginAccessToken: string, endpointUrl: string): Promise<string>;
  setWebhookEndpoint(messagingAccessToken: string, webhookUrl: string): Promise<void>;
  getBotUserId(messagingAccessToken: string): Promise<string>;
}

async function realCreateLiffApp(loginAccessToken: string, endpointUrl: string): Promise<string> {
  const res = await fetch(LIFF_APPS_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${loginAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ view: { type: "full", url: endpointUrl } }),
  });
  if (!res.ok) throw new ValidationError("Failed to create LIFF app via LIFF Server API.");
  const data = (await res.json()) as { liffId?: string };
  if (!data.liffId) throw new ValidationError("LIFF Server API returned no liffId.");
  return data.liffId;
}

async function realSetWebhookEndpoint(messagingAccessToken: string, webhookUrl: string): Promise<void> {
  const res = await fetch(MESSAGING_WEBHOOK_ENDPOINT_URL, {
    method: "PUT",
    headers: { Authorization: `Bearer ${messagingAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: webhookUrl }),
  });
  if (!res.ok) throw new ValidationError("Failed to set Messaging API webhook endpoint.");
}

async function realGetBotUserId(messagingAccessToken: string): Promise<string> {
  const res = await fetch(BOT_INFO_ENDPOINT, { headers: { Authorization: `Bearer ${messagingAccessToken}` } });
  if (!res.ok) throw new ValidationError("Failed to fetch bot info from Messaging API.");
  const data = (await res.json()) as { userId?: string };
  if (!data.userId) throw new ValidationError("Messaging API bot/info returned no userId.");
  return data.userId;
}

export const realLineProvisioningClient: LineProvisioningClient = {
  issueLoginToken: issueChannelAccessToken,
  createLiffApp: realCreateLiffApp,
  setWebhookEndpoint: realSetWebhookEndpoint,
  getBotUserId: realGetBotUserId,
};

function configRef(merchantId: string) {
  return getDb().collection(COLLECTIONS.lineChannelConfigs).doc(merchantId);
}

/**
 * Owner submits the 5 values §20 Step 4 requires (4 original + the Phase 7 V1 long-lived
 * Messaging Access Token, per the locked decision) → this stores all secrets via `SecretStore`
 * (never in Firestore directly), provisions the LIFF app, registers the webhook, and marks the
 * connection `CONNECTED`.
 */
export async function connectLineChannel(
  ctx: AuthContext,
  input: ConnectLineChannelInput,
  webhookBaseUrl: string,
  client: LineProvisioningClient = realLineProvisioningClient,
): Promise<LineChannelConfig> {
  requireOwner(ctx, ctx.merchantId);

  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ValidationError(`${field} is required.`);
    }
  }

  const secretStore = getSecretStore();
  const messagingSecretRef = await secretStore.putSecret(
    `line-messaging-secret-${ctx.merchantId}`,
    input.messagingChannelSecret,
  );
  const messagingAccessTokenRef = await secretStore.putSecret(
    `line-messaging-access-token-${ctx.merchantId}`,
    input.messagingChannelAccessToken,
  );
  const loginSecretRef = await secretStore.putSecret(`line-login-secret-${ctx.merchantId}`, input.loginChannelSecret);

  // Bug fix (pre-staging-deployment review): the LIFF endpoint URL must point at the merchant's
  // `slug`, not its raw Firestore document id — `/m/[merchantSlug]/page.tsx` resolves the
  // merchant ONLY via `getPublicMerchantProfileBySlug` (a `slug` lookup). Registering
  // `ctx.merchantId` here would make the LIFF app LINE provisions 404 for every real customer,
  // since a merchant's self-chosen slug never equals its auto-generated document id.
  const merchant = await getMerchantRecordOrThrow(ctx.merchantId);

  // Self-issue a Login channel token now (verified working, §35 spike) to provision the LIFF app.
  const loginToken = await client.issueLoginToken(input.loginChannelId, input.loginChannelSecret);
  const liffId = await client.createLiffApp(loginToken, `${webhookBaseUrl}/m/${merchant.slug}`);
  await client.setWebhookEndpoint(input.messagingChannelAccessToken, `${webhookBaseUrl}/api/webhooks/line`);
  const botUserId = await client.getBotUserId(input.messagingChannelAccessToken);

  const now = FieldValue.serverTimestamp();
  const doc: Omit<LineChannelConfig, "createdAt" | "updatedAt"> = {
    merchantId: ctx.merchantId,
    lineProviderId: input.lineProviderId,
    messagingChannel: {
      channelId: input.messagingChannelId,
      botUserId,
      channelSecretRef: messagingSecretRef,
      accessTokenRef: messagingAccessTokenRef,
      status: "CONNECTED",
    },
    loginChannel: {
      channelId: input.loginChannelId,
      channelSecretRef: loginSecretRef,
      accessTokenRef: null, // self-issued fresh per call, never persisted long-term
      liffId,
      status: "CONNECTED",
    },
    linkedVerifiedAt: FieldValue.serverTimestamp() as never,
    overallStatus: "CONNECTED",
  };
  await configRef(ctx.merchantId).set({ ...doc, createdAt: now, updatedAt: now });

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "line_connection.connected",
    targetType: "lineChannelConfig",
    targetId: ctx.merchantId,
    after: { overallStatus: "CONNECTED" },
  });

  const snap = await configRef(ctx.merchantId).get();
  return snap.data() as LineChannelConfig;
}

/** Owner-only status read — never returns secret/token values, only connection status. */
export async function getLineChannelStatus(ctx: AuthContext): Promise<Pick<LineChannelConfig, "overallStatus" | "messagingChannel" | "loginChannel"> | null> {
  requireOwner(ctx, ctx.merchantId);
  const snap = await configRef(ctx.merchantId).get();
  if (!snap.exists) return null;
  const data = snap.data() as LineChannelConfig;
  return {
    overallStatus: data.overallStatus,
    messagingChannel: { ...data.messagingChannel, channelSecretRef: "***", accessTokenRef: "***" },
    loginChannel: { ...data.loginChannel, channelSecretRef: "***", accessTokenRef: null },
  };
}

/** Internal — loads the full config (including secret refs) for server-only callers (webhook
 * receiver, `LineAdapter`). Never exposed through any API route. */
export async function loadLineChannelConfigInternal(merchantId: string): Promise<LineChannelConfig> {
  const snap = await configRef(merchantId).get();
  if (!snap.exists) throw new NotFoundError(`No LINE connection configured for merchant ${merchantId}.`);
  return snap.data() as LineChannelConfig;
}

/** §35-verified working path: Login channel token via `client_credentials`. */
export async function issueChannelAccessToken(channelId: string, channelSecret: string): Promise<string> {
  const res = await fetch(LINE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: channelId, client_secret: channelSecret }).toString(),
  });
  if (!res.ok) throw new ValidationError("Failed to issue LINE channel access token.");
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new ValidationError("LINE token endpoint returned no access_token.");
  return data.access_token;
}

/** Resolves the Login channel's live access token by re-issuing it via `client_credentials` each
 * call (15-minute TTL, never persisted — §35 confirmed this path works for Login channels). */
export async function getLoginChannelAccessToken(merchantId: string): Promise<string> {
  const config = await loadLineChannelConfigInternal(merchantId);
  const secret = await getSecretStore().getSecret(config.loginChannel.channelSecretRef);
  return issueChannelAccessToken(config.loginChannel.channelId, secret);
}

/** V1: reads the Console-issued long-lived Messaging Access Token directly — never self-issued
 * for this channel type (locked Phase 7 decision, §19). */
export async function getMessagingChannelAccessToken(merchantId: string): Promise<string> {
  const config = await loadLineChannelConfigInternal(merchantId);
  return getSecretStore().getSecret(config.messagingChannel.accessTokenRef);
}

/**
 * Webhook signature verification (§19: "verify signature (x-line-signature) ทุก request ก่อน
 * ประมวลผล"). `timingSafeEqual` guards against timing side-channel attacks on the comparison
 * itself — the same class of care CLAUDE.md's security-review posture expects for every
 * credential-adjacent check in this codebase.
 */
export function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, channelSecret: string): boolean {
  if (!signatureHeader) return false;
  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

/** Resolves `merchantId` from a webhook's `destination` field (the bot's own userId, NOT its
 * Channel ID — a common point of confusion) — never from any other client-controllable field
 * (§19, §26 tenant-isolation posture). */
export async function resolveMerchantIdFromWebhookDestination(destination: string): Promise<string | null> {
  const snap = await getDb()
    .collection(COLLECTIONS.lineChannelConfigs)
    .where("messagingChannel.botUserId", "==", destination)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].id;
}
