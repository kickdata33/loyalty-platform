import { getMessagingChannelAccessToken } from "@/modules/line-channel/service";
import type { ChannelAdapter } from "@/modules/notification/adapters/channel-adapter";
import { ValidationError } from "@/modules/shared/errors";

const PUSH_MESSAGE_ENDPOINT = "https://api.line.me/v2/bot/message/push";

/**
 * Real Messaging API push-message adapter (§23). Reads the Messaging API channel's access token
 * via `getMessagingChannelAccessToken` — V1 uses the Console-issued long-lived token (locked
 * Phase 7 decision, §19), never self-issued for this channel type. `recipientId` is always a
 * LINE userId already resolved server-side (`merchantLineIdentity.lineUserId` for
 * `SEND_NOTIFICATION`, or the Owner-configured `testRecipientLineUserId` for Test Send) — never a
 * client-supplied value.
 */
export class LineAdapter implements ChannelAdapter {
  async send(params: { merchantId: string; recipientId: string; body: string }): Promise<void> {
    const accessToken = await getMessagingChannelAccessToken(params.merchantId);
    const res = await fetch(PUSH_MESSAGE_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: params.recipientId, messages: [{ type: "text", text: params.body }] }),
    });
    if (!res.ok) {
      throw new ValidationError(`LINE push message failed (HTTP ${res.status}).`);
    }
  }
}
