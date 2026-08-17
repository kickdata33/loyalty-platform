import { describe, expect, it } from "vitest";

import { resolveMerchantDayBoundary } from "@/modules/report/service";

/**
 * §24 "Report Period Boundaries — Merchant-Local Timezone" (Phase 8 Architecture Decision,
 * Locked) — pure unit tests, no emulator needed (`resolveMerchantDayBoundary` has zero I/O).
 *
 * The core claim under test: a UTC-day boundary (as `dailyAutomationBatch`'s Phase 6 `todayKey`
 * uses) is WRONG for report periods — a Bangkok (UTC+7) merchant's calendar day does not line up
 * with a UTC calendar day, and the gap is large enough (7 hours) to move real activity into the
 * wrong day if this weren't computed per-timezone.
 */
describe("resolveMerchantDayBoundary — merchant-local calendar day (§24, Phase 8 Locked)", () => {
  it("resolves the correct Bangkok (UTC+7) calendar day even when it differs from the UTC day", () => {
    // 2026-08-17 01:00 UTC = 2026-08-17 08:00 Bangkok — same UTC day, unremarkable case.
    const morningUtc = new Date("2026-08-17T01:00:00.000Z");
    expect(resolveMerchantDayBoundary("Asia/Bangkok", morningUtc).dateKey).toBe("2026-08-17");

    // 2026-08-17 20:00 UTC = 2026-08-18 03:00 Bangkok — the UTC day is still the 17th, but the
    // Bangkok calendar day has already rolled over to the 18th. A UTC-day-boundary implementation
    // would get this wrong; this is exactly the bug the Phase 8 decision exists to prevent.
    const lateEveningUtc = new Date("2026-08-17T20:00:00.000Z");
    expect(resolveMerchantDayBoundary("Asia/Bangkok", lateEveningUtc).dateKey).toBe("2026-08-18");
  });

  it("dayStart/dayEnd bracket a full 24h Bangkok calendar day, offset +07:00 from UTC midnight", () => {
    const { dateKey, dayStart, dayEnd } = resolveMerchantDayBoundary("Asia/Bangkok", new Date("2026-08-17T10:00:00.000Z"));
    expect(dateKey).toBe("2026-08-17");
    // Bangkok midnight (00:00 +07:00) = 2026-08-16T17:00:00.000Z.
    expect(dayStart.toISOString()).toBe("2026-08-16T17:00:00.000Z");
    expect(dayEnd.toISOString()).toBe("2026-08-17T17:00:00.000Z");
    expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("an instant exactly at merchant-local midnight belongs to the day that just started, not the one that just ended", () => {
    const exactMidnightUtc = new Date("2026-08-16T17:00:00.000Z"); // = 2026-08-17T00:00:00 +07:00
    expect(resolveMerchantDayBoundary("Asia/Bangkok", exactMidnightUtc).dateKey).toBe("2026-08-17");
  });

  it("is consistent across a different fixed-offset timezone (UTC itself)", () => {
    const at = new Date("2026-08-17T15:30:00.000Z");
    const boundary = resolveMerchantDayBoundary("UTC", at);
    expect(boundary.dateKey).toBe("2026-08-17");
    expect(boundary.dayStart.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(boundary.dayEnd.toISOString()).toBe("2026-08-18T00:00:00.000Z");
  });
});
