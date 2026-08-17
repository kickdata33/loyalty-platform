import { describe, expect, it } from "vitest";

import { sendBroadcast, sendTestBroadcast, updateNotificationSettings } from "@/modules/notification/service";
import type { ChannelAdapter } from "@/modules/notification/adapters/channel-adapter";
import { ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createMerchantFixture } from "./setup";

class RecordingAdapter implements ChannelAdapter {
  calls: { merchantId: string; recipientId: string; body: string }[] = [];
  async send(params: { merchantId: string; recipientId: string; body: string }): Promise<void> {
    this.calls.push(params);
  }
}

async function setupBroadcastableTemplate(ownerCtx: Parameters<typeof updateNotificationSettings>[0]) {
  await updateNotificationSettings(ownerCtx, {
    templates: { PROMOTION: { enabled: true, body: "hello {{name}}" } },
    testRecipientLineUserId: "U_test_recipient",
  });
}

/**
 * Broadcast Rate Limiting (§26 "Broadcast spam / message flooding", §38.1, Phase 10 Blocker 1,
 * Locked — Option A). Reserve-then-send, checked inside the same transaction as the write, same
 * principle already locked for Staff Limits (§9/§11) and Entitlement Limits (§37.3).
 */
describe("Broadcast Rate Limiting — sendBroadcast (§38.1)", () => {
  it("blocks a broadcast once the merchant's maxBroadcastsPerDay is reached, and reflects it in a ValidationError", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setupBroadcastableTemplate(ownerCtx);
    // Lower the limit so the test doesn't need to send 5 real broadcasts first.
    await getDb().collection(COLLECTIONS.merchants).doc(merchantId).update({ "broadcastLimits.maxBroadcastsPerDay": 1 });

    await sendBroadcast(ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter());
    await expect(
      sendBroadcast(ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter()),
    ).rejects.toThrow(ValidationError);

    const broadcastsSnap = await getDb().collection(COLLECTIONS.broadcasts).where("merchantId", "==", merchantId).get();
    expect(broadcastsSnap.size).toBe(1); // the blocked attempt never reserved a second slot
  });

  it("two concurrent broadcasts racing the same limit=1 never both succeed", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setupBroadcastableTemplate(ownerCtx);
    await getDb().collection(COLLECTIONS.merchants).doc(merchantId).update({ "broadcastLimits.maxBroadcastsPerDay": 1 });

    const results = await Promise.allSettled([
      sendBroadcast(ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter()),
      sendBroadcast(ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter()),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const broadcastsSnap = await getDb().collection(COLLECTIONS.broadcasts).where("merchantId", "==", merchantId).get();
    expect(broadcastsSnap.size).toBe(1); // never 2, even under contention
  });

  it("merchant A's broadcast count never affects merchant B's limit (tenant isolation)", async () => {
    const merchantA = await createMerchantFixture("Broadcast Limit A");
    const merchantB = await createMerchantFixture("Broadcast Limit B");
    await setupBroadcastableTemplate(merchantA.ownerCtx);
    await setupBroadcastableTemplate(merchantB.ownerCtx);
    await getDb().collection(COLLECTIONS.merchants).doc(merchantA.merchantId).update({ "broadcastLimits.maxBroadcastsPerDay": 1 });

    await sendBroadcast(merchantA.ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter());
    await expect(
      sendBroadcast(merchantA.ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter()),
    ).rejects.toThrow(ValidationError);

    // Merchant B, with its own independent (default) limit, is entirely unaffected.
    await expect(
      sendBroadcast(merchantB.ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter()),
    ).resolves.toBeTruthy();
  });

  it("sendTestBroadcast is NOT rate-limited", async () => {
    const { ownerCtx, merchantId } = await createMerchantFixture();
    await setupBroadcastableTemplate(ownerCtx);
    await getDb().collection(COLLECTIONS.merchants).doc(merchantId).update({ "broadcastLimits.maxBroadcastsPerDay": 1 });

    // Well over the (already-low) broadcastLimit — sendTestBroadcast must never consult it.
    for (let i = 0; i < 3; i++) {
      await expect(sendTestBroadcast(ownerCtx, "test body", new RecordingAdapter())).resolves.toBeUndefined();
    }
  });

  it("a new merchant is seeded with a default broadcastLimits.maxBroadcastsPerDay", async () => {
    const { merchantId } = await createMerchantFixture();
    const snap = await getDb().collection(COLLECTIONS.merchants).doc(merchantId).get();
    const broadcastLimits = (snap.data() as { broadcastLimits?: { maxBroadcastsPerDay: number } }).broadcastLimits;
    expect(broadcastLimits?.maxBroadcastsPerDay).toBeGreaterThan(0);
  });
});
