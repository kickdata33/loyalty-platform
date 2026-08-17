import { describe, expect, it } from "vitest";

import { getReportSettings, updateReportSettings } from "@/modules/report/service";
import { AuthorizationError, ValidationError } from "@/modules/shared/errors";

import { addStaffFixture, createMerchantFixture } from "./setup";

/**
 * `merchants/{merchantId}.reportSettings` (§5, §24 "Report Settings Schema Location", Phase 8
 * Locked) — RBAC (Owner/Manager only, Staff excluded per §9's "ห้ามดู Management Reports"),
 * tenant isolation (settings changes only ever affect the caller's own merchant — enforced by
 * construction, since `updateReportSettings` always derives `merchantId` from `ctx`, never from
 * request input), and item-enum validation.
 */

describe("getReportSettings / updateReportSettings — RBAC (§9)", () => {
  it("Owner and Manager can both read and write; Staff can do neither", async () => {
    const { ownerCtx } = await createMerchantFixture();
    const manager = await addStaffFixture(ownerCtx, "MANAGER");
    const staff = await addStaffFixture(ownerCtx, "STAFF");

    // Off by default (§24 Locked decision) until an Owner/Manager opts in.
    const initial = await getReportSettings(ownerCtx);
    expect(initial).toMatchObject({ dailyEnabled: false, weeklyEnabled: false, monthlyEnabled: false });

    await updateReportSettings(ownerCtx, {
      dailyEnabled: true,
      weeklyEnabled: false,
      monthlyEnabled: false,
      dailyItems: ["NEW_MEMBERS", "POINTS"],
      weeklyItems: [],
      monthlyItems: [],
    });
    await expect(getReportSettings(manager.ctx)).resolves.toMatchObject({ dailyEnabled: true });

    await updateReportSettings(manager.ctx, {
      dailyEnabled: true,
      weeklyEnabled: true,
      monthlyEnabled: false,
      dailyItems: ["NEW_MEMBERS"],
      weeklyItems: ["RETURNING"],
      monthlyItems: [],
    });
    await expect(getReportSettings(ownerCtx)).resolves.toMatchObject({ weeklyEnabled: true });

    await expect(getReportSettings(staff.ctx)).rejects.toThrow(AuthorizationError);
    await expect(
      updateReportSettings(staff.ctx, {
        dailyEnabled: true,
        weeklyEnabled: false,
        monthlyEnabled: false,
        dailyItems: [],
        weeklyItems: [],
        monthlyItems: [],
      }),
    ).rejects.toThrow(AuthorizationError);
  });

  it("rejects an item name outside §24's own documented per-frequency list", async () => {
    const { ownerCtx } = await createMerchantFixture();
    await expect(
      updateReportSettings(ownerCtx, {
        dailyEnabled: true,
        weeklyEnabled: false,
        monthlyEnabled: false,
        dailyItems: ["REVENUE" as never], // never a valid item — §0/§24 ban Sales/Revenue entirely
        weeklyItems: [],
        monthlyItems: [],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("a merchant's settings change never affects another merchant (tenant isolation by construction)", async () => {
    const merchantA = await createMerchantFixture("A");
    const merchantB = await createMerchantFixture("B");

    await updateReportSettings(merchantA.ownerCtx, {
      dailyEnabled: true,
      weeklyEnabled: true,
      monthlyEnabled: true,
      dailyItems: ["NEW_MEMBERS"],
      weeklyItems: ["RETURNING"],
      monthlyItems: ["RETENTION"],
    });

    const settingsB = await getReportSettings(merchantB.ownerCtx);
    expect(settingsB).toMatchObject({ dailyEnabled: false, weeklyEnabled: false, monthlyEnabled: false });
  });
});
