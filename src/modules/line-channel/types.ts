import type { Timestamp } from "firebase-admin/firestore";

/** `lineChannelConfigs/{merchantId}` — FINAL-ARCHITECTURE.md §5, §19. Deny-all client access —
 * server/Cloud-Function-only, same as every credential-adjacent collection in this codebase. */
export type LineChannelStatus = "CONNECTED" | "PARTIAL" | "DISCONNECTED" | "ERROR";

export interface LineChannelConfig {
  merchantId: string;
  lineProviderId: string;
  messagingChannel: {
    channelId: string;
    /** The bot's own LINE userId (from `GET /v2/bot/info`) — webhook payloads' `destination`
     * field is THIS value, not `channelId` (§19 "resolve merchant จาก destination field"). */
    botUserId: string | null;
    channelSecretRef: string;
    /** V1: Console-issued long-lived token, per the locked Phase 7 "Messaging API Channel Access
     * Token" decision (§19) — never self-issued via `client_credentials` for this channel type. */
    accessTokenRef: string;
    status: LineChannelStatus;
  };
  loginChannel: {
    channelId: string;
    channelSecretRef: string;
    /** Self-issued via `client_credentials` at call time (verified working, §35 spike) — this ref
     * holds the most recently issued token, refreshed on expiry by `getLoginChannelAccessToken`. */
    accessTokenRef: string | null;
    liffId: string | null;
    status: LineChannelStatus;
  };
  linkedVerifiedAt: Timestamp | null;
  overallStatus: LineChannelStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
