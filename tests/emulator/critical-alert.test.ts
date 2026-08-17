import { describe, expect, it } from "vitest";

import {
  getCriticalAlertSettings,
  reportCriticalError,
  setCriticalAlertSettings,
} from "@/modules/ops-alert/service";
import { ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";

import { createSuperAdminFixture, uniqueId } from "./setup";

/**
 * Monitoring & Critical Alert Path — in-app half (§30, §38.2, Phase 10 Blocker 2; live-delivery
 * mechanism revised to Option B, locked). Settings storage/audit is preserved for forward
 * compatibility; `reportCriticalError` only ever writes the `criticalErrors` audit trail — no
 * LINE (or any other) delivery is attempted, since every LINE channel in this architecture is
 * per-merchant (§19/§20) and none may be reused for a platform-level alert.
 */
describe("setCriticalAlertSettings / getCriticalAlertSettings — Super Admin only, audited, preserved for forward compatibility (§38.2)", () => {
  it("requires a non-empty reason", async () => {
    const admin = await createSuperAdminFixture();
    await expect(setCriticalAlertSettings(admin.ctx, { lineUserId: "U123" }, "")).rejects.toThrow(ValidationError);
  });

  it("sets and clears the recipient, and records before/after in an audit log", async () => {
    const admin = await createSuperAdminFixture();
    await setCriticalAlertSettings(admin.ctx, { lineUserId: "U_ops" }, "initial setup");
    const after = await getCriticalAlertSettings();
    expect(after.criticalAlertRecipient).toEqual({ lineUserId: "U_ops" });

    await setCriticalAlertSettings(admin.ctx, { lineUserId: null }, "no longer needed");
    const cleared = await getCriticalAlertSettings();
    expect(cleared.criticalAlertRecipient).toBeNull();

    const auditSnap = await getDb()
      .collection(COLLECTIONS.auditLogs)
      .where("action", "==", "ops_settings.critical_alert_recipient_updated")
      .where("actorId", "==", admin.authUid)
      .get();
    expect(auditSnap.size).toBeGreaterThanOrEqual(2);
  });
});

describe("reportCriticalError — always writes criticalErrors, never attempts delivery, never throws (§38.2 addendum, Option B)", () => {
  it("writes a criticalErrors entry with alertSent: false when NO recipient is configured", async () => {
    const merchantId = uniqueId("merchant");
    await reportCriticalError({
      merchantId,
      source: "test-source",
      message: "something went wrong",
      context: { count: 3 },
    });

    const snap = await getDb().collection(COLLECTIONS.criticalErrors).where("merchantId", "==", merchantId).get();
    expect(snap.size).toBe(1);
    expect(snap.docs[0].data()).toMatchObject({ source: "test-source", alertSent: false });
  });

  it("STILL writes alertSent: false even when a recipient IS configured — delivery is never attempted (§38.2 addendum)", async () => {
    const admin = await createSuperAdminFixture();
    await setCriticalAlertSettings(admin.ctx, { lineUserId: "U_ops" }, "test setup");
    const merchantId = uniqueId("merchant");

    await reportCriticalError({ merchantId, source: "test-source-2", message: "critical!" });

    const snap = await getDb().collection(COLLECTIONS.criticalErrors).where("merchantId", "==", merchantId).get();
    expect(snap.docs[0].data()).toMatchObject({ alertSent: false });

    await setCriticalAlertSettings(admin.ctx, { lineUserId: null }, "cleanup");
  });

  it("never throws", async () => {
    await expect(
      reportCriticalError({ merchantId: uniqueId("merchant"), source: "test-source-3", message: "boom" }),
    ).resolves.toBeUndefined();
  });

  it("supports merchantId: null for platform-wide errors", async () => {
    await expect(
      reportCriticalError({ merchantId: null, source: "test-platform-wide", message: "no single merchant" }),
    ).resolves.toBeUndefined();
  });
});
