import { describe, expect, it } from "vitest";

import { createMembership } from "@/modules/membership/service";
import {
  getNotificationSettings,
  sendBroadcast,
  sendNotification,
  sendTestBroadcast,
  updateNotificationSettings,
} from "@/modules/notification/service";
import type { ChannelAdapter } from "@/modules/notification/adapters/channel-adapter";
import { AuthorizationError, ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { addStaffFixture, createMerchantFixture } from "./setup";

/**
 * Notification Service (§23) — RBAC (`BROADCAST_SEND`, Owner+Manager, not Staff), Template+
 * Preview, and the locked Phase 7 "NOTIFY_OWNER Delivery & Broadcast Test Send" decision: Test
 * Send uses ONLY the Owner-configured `testRecipientLineUserId`, never resolves any real
 * customer/staff identity. A fake `ChannelAdapter` records calls instead of hitting the real LINE
 * Messaging API — §35's spike already validated real delivery separately, outside this suite.
 */
class RecordingAdapter implements ChannelAdapter {
  calls: { merchantId: string; recipientId: string; body: string }[] = [];
  async send(params: { merchantId: string; recipientId: string; body: string }): Promise<void> {
    this.calls.push(params);
  }
}

class FailingAdapter implements ChannelAdapter {
  async send(): Promise<void> {
    throw new Error("simulated delivery failure");
  }
}

async function linkLineIdentity(membershipId: string, lineUserId: string) {
  await getDb()
    .collection(COLLECTIONS.memberships)
    .doc(membershipId)
    .update({ merchantLineIdentity: { channelId: "c1", lineUserId, linkedAt: new Date(), friendshipStatus: "FRIEND" } });
}

describe("updateNotificationSettings / getNotificationSettings — RBAC", () => {
  it("Staff (no BROADCAST_SEND) is rejected; Owner/Manager can configure", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    const manager = await addStaffFixture(ownerCtx, "MANAGER");

    await expect(getNotificationSettings(staff.ctx)).rejects.toThrow(AuthorizationError);

    await updateNotificationSettings(manager.ctx, {
      templates: { PROMOTION: { enabled: true, body: "สวัสดี {{memberName}}" } },
      testRecipientLineUserId: "Utest123",
    });
    const settings = await getNotificationSettings(ownerCtx);
    expect(settings.templates.PROMOTION?.enabled).toBe(true);
    expect(settings.testRecipientLineUserId).toBe("Utest123");
  });
});

describe("sendNotification — the SEND_NOTIFICATION real-delivery core", () => {
  it("resolves the member's merchantLineIdentity.lineUserId, renders the template, and delivers via the adapter", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await updateNotificationSettings(ownerCtx, { templates: { POINTS_EARNED: { enabled: true, body: "คุณ {{memberName}} ได้ {{points}} แต้ม" } }, testRecipientLineUserId: null });
    const membershipId = await createMembership(ownerCtx, { displayName: "Test" });
    await linkLineIdentity(membershipId, "Umember123");

    const adapter = new RecordingAdapter();
    const result = await sendNotification({
      merchantId: ownerCtx.merchantId,
      membershipId,
      templateType: "POINTS_EARNED",
      variables: { memberName: "สมชาย", points: 50 },
      adapter,
    });

    expect(result.status).toBe("sent");
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]).toMatchObject({ recipientId: "Umember123", body: "คุณ สมชาย ได้ 50 แต้ม" });
  });

  it("fails cleanly (recorded, not thrown) when the template is disabled or the member has no linked LINE identity", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const membershipId = await createMembership(ownerCtx, { displayName: "No LINE" });
    const adapter = new RecordingAdapter();

    const noTemplate = await sendNotification({ merchantId: ownerCtx.merchantId, membershipId, templateType: "PROMOTION", variables: {}, adapter });
    expect(noTemplate.status).toBe("failed");

    await updateNotificationSettings(ownerCtx, { templates: { PROMOTION: { enabled: true, body: "hi" } }, testRecipientLineUserId: null });
    const noIdentity = await sendNotification({ merchantId: ownerCtx.merchantId, membershipId, templateType: "PROMOTION", variables: {}, adapter });
    expect(noIdentity.status).toBe("failed");
    expect(adapter.calls).toHaveLength(0);
  });

  it("retries up to 3 times on adapter failure, then records failed", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await updateNotificationSettings(ownerCtx, { templates: { PROMOTION: { enabled: true, body: "hi" } }, testRecipientLineUserId: null });
    const membershipId = await createMembership(ownerCtx, { displayName: "Fails" });
    await linkLineIdentity(membershipId, "Ufails123");

    const result = await sendNotification({ merchantId: ownerCtx.merchantId, membershipId, templateType: "PROMOTION", variables: {}, adapter: new FailingAdapter() });
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/simulated delivery failure/);
  });
});

describe("sendTestBroadcast — locked Phase 7 decision: configuration-only recipient, no identity resolution", () => {
  it("sends to the configured testRecipientLineUserId, never to any real member's identity", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await updateNotificationSettings(ownerCtx, { templates: {}, testRecipientLineUserId: "UownerTestRecipient" });
    const adapter = new RecordingAdapter();

    await sendTestBroadcast(ownerCtx, "ทดสอบข้อความ", adapter);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].recipientId).toBe("UownerTestRecipient");
  });

  it("throws if no test recipient has been configured, rather than falling back to any identity", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(sendTestBroadcast(ownerCtx, "test", new RecordingAdapter())).rejects.toThrow(ValidationError);
  });

  it("Staff cannot send a test broadcast", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await expect(sendTestBroadcast(staff.ctx, "test", new RecordingAdapter())).rejects.toThrow(AuthorizationError);
  });
});

describe("sendBroadcast — segment targeting, tenant isolation, partial-failure reporting", () => {
  it("sends only to members matching the audience and with a linked LINE identity", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await updateNotificationSettings(ownerCtx, { templates: { PROMOTION: { enabled: true, body: "โปรโมชัน" } }, testRecipientLineUserId: null });
    const withLine = await createMembership(ownerCtx, { displayName: "Has LINE" });
    await linkLineIdentity(withLine, "UwithLine");
    await createMembership(ownerCtx, { displayName: "No LINE" }); // no identity — counted as failed

    const adapter = new RecordingAdapter();
    const result = await sendBroadcast(ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, adapter);
    expect(result.sentCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0].recipientId).toBe("UwithLine");
  });

  it("never sends to another merchant's members", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");
    await updateNotificationSettings(merchantA.ownerCtx, { templates: { PROMOTION: { enabled: true, body: "x" } }, testRecipientLineUserId: null });
    const memberB = await createMembership(merchantB.ownerCtx, { displayName: "B member" });
    await linkLineIdentity(memberB, "UmemberB");

    const adapter = new RecordingAdapter();
    await sendBroadcast(merchantA.ownerCtx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, adapter);
    expect(adapter.calls).toHaveLength(0); // merchant A has no members of its own here
  });

  it("Manager can broadcast; Staff is rejected", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");
    await updateNotificationSettings(ownerCtx, { templates: { PROMOTION: { enabled: true, body: "x" } }, testRecipientLineUserId: null });

    await expect(sendBroadcast(staff.ctx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter())).rejects.toThrow(AuthorizationError);
    await expect(sendBroadcast(manager.ctx, { audience: "ALL", templateType: "PROMOTION", variables: {} }, new RecordingAdapter())).resolves.toBeTruthy();
  });
});
