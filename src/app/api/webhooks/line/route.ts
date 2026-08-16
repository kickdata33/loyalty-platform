import { NextResponse } from "next/server";

import { getDb } from "@/modules/shared/firestore";
import { checkIdempotencyKey, recordIdempotencyKey } from "@/modules/shared/idempotency";
import {
  loadLineChannelConfigInternal,
  resolveMerchantIdFromWebhookDestination,
  verifyWebhookSignature,
} from "@/modules/line-channel/service";
import { getSecretStore } from "@/modules/shared/secret-store";

export const runtime = "nodejs";

/**
 * Central LINE webhook receiver (FINAL-ARCHITECTURE.md §19). One URL for every merchant — never
 * one per merchant. Signature verified BEFORE anything else is trusted; merchant resolved from
 * the payload's `destination` field (the bot's own userId), never any staff/Bearer auth (LINE
 * itself is the caller, not a signed-in staff session — the one intentional exception to Bearer
 * auth in this codebase).
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");

  let payload: { destination?: string; events?: { webhookEventId?: string; type: string }[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!payload.destination) {
    return NextResponse.json({ error: "Missing destination." }, { status: 400 });
  }

  const merchantId = await resolveMerchantIdFromWebhookDestination(payload.destination);
  if (!merchantId) {
    // Unknown destination — never confirm/deny which merchants exist to an unauthenticated caller
    // beyond a generic 404; do not process anything.
    return NextResponse.json({ error: "Unknown destination." }, { status: 404 });
  }

  const config = await loadLineChannelConfigInternal(merchantId);
  const channelSecret = await getSecretStore().getSecret(config.messagingChannel.channelSecretRef);
  if (!verifyWebhookSignature(rawBody, signature, channelSecret)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  const db = getDb();
  for (const event of payload.events ?? []) {
    const eventId = event.webhookEventId;
    if (!eventId) continue; // no reliable idempotency key — skip rather than risk double-processing
    // V1 scope (§19, §33): idempotent receipt + signature verification only — record that this
    // event id was seen so a LINE retry never reprocesses it. Conversational bot logic (message
    // replies, follow/unfollow → merchantLineIdentity.friendshipStatus updates) is not named in
    // §19/§33's Phase 7 DoD text and is left for a future phase, not guessed here.
    await db.runTransaction(async (tx) => {
      const existing = await checkIdempotencyKey(tx, merchantId, "line.webhook_event", eventId);
      if (existing) return; // already processed — LINE's own retry, no-op
      recordIdempotencyKey(tx, merchantId, "line.webhook_event", eventId, eventId);
    });
  }

  return NextResponse.json({ ok: true });
}
