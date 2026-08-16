import { Timestamp } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { evaluatePointRules } from "@/modules/points/rule-engine";
import type { PointRule } from "@/modules/points/types";

/**
 * Pure unit tests of the Rule Stacking Algorithm (FINAL-ARCHITECTURE.md §11) — no emulator
 * needed, this function has zero I/O.
 */

let counter = 0;
function rule(overrides: Partial<PointRule>): PointRule {
  counter += 1;
  return {
    id: `rule-${counter}`,
    merchantId: "m1",
    name: `Rule ${counter}`,
    enabled: true,
    type: "PER_VISIT",
    role: "BASE",
    branchScope: [],
    startAt: null,
    endAt: null,
    priority: 100,
    stackingPolicy: "ADDITIVE",
    config: {},
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

const NOW = new Date("2026-01-15T12:00:00Z");

describe("evaluatePointRules — BASE rule selection", () => {
  it("returns 0 when no BASE rule matches the event's sourceType", () => {
    const result = evaluatePointRules([], { sourceType: "PER_VISIT", branchId: null, now: NOW });
    expect(result.finalPoints).toBe(0);
    expect(result.appliedRules).toEqual([]);
  });

  it("PER_VISIT rule contributes config.pointsPerVisit", () => {
    const rules = [rule({ type: "PER_VISIT", config: { pointsPerVisit: 10 } })];
    const result = evaluatePointRules(rules, { sourceType: "PER_VISIT", branchId: null, now: NOW });
    expect(result.finalPoints).toBe(10);
    expect(result.appliedRules).toHaveLength(1);
  });

  it("PER_UNIT rule contributes pointsPerUnit × units", () => {
    const rules = [rule({ type: "PER_UNIT", config: { unit: "HOUR", pointsPerUnit: 5 } })];
    const result = evaluatePointRules(rules, {
      sourceType: "PER_UNIT",
      units: 3,
      branchId: null,
      now: NOW,
    });
    expect(result.finalPoints).toBe(15);
  });

  it("when multiple BASE candidates match, the lowest priority number wins", () => {
    const rules = [
      rule({ type: "PER_VISIT", priority: 50, config: { pointsPerVisit: 100 } }),
      rule({ type: "PER_VISIT", priority: 10, config: { pointsPerVisit: 5 } }),
    ];
    const result = evaluatePointRules(rules, { sourceType: "PER_VISIT", branchId: null, now: NOW });
    expect(result.finalPoints).toBe(5); // priority 10 (lower) wins over priority 50
  });

  it("a disabled rule never contributes", () => {
    const rules = [rule({ type: "PER_VISIT", enabled: false, config: { pointsPerVisit: 10 } })];
    expect(evaluatePointRules(rules, { sourceType: "PER_VISIT", branchId: null, now: NOW }).finalPoints).toBe(0);
  });

  it("a rule outside its startAt/endAt window never contributes", () => {
    const future = rule({
      type: "PER_VISIT",
      startAt: Timestamp.fromDate(new Date("2027-01-01")),
      config: { pointsPerVisit: 10 },
    });
    const expired = rule({
      type: "PER_VISIT",
      endAt: Timestamp.fromDate(new Date("2025-01-01")),
      config: { pointsPerVisit: 10 },
    });
    expect(evaluatePointRules([future], { sourceType: "PER_VISIT", branchId: null, now: NOW }).finalPoints).toBe(0);
    expect(evaluatePointRules([expired], { sourceType: "PER_VISIT", branchId: null, now: NOW }).finalPoints).toBe(0);
  });

  it("empty branchScope applies to all branches; non-empty branchScope restricts", () => {
    const universal = rule({ type: "PER_VISIT", branchScope: [], config: { pointsPerVisit: 10 } });
    const scoped = rule({ type: "PER_VISIT", branchScope: ["branch-a"], config: { pointsPerVisit: 10 } });

    expect(
      evaluatePointRules([universal], { sourceType: "PER_VISIT", branchId: "branch-x", now: NOW }).finalPoints,
    ).toBe(10);
    expect(
      evaluatePointRules([scoped], { sourceType: "PER_VISIT", branchId: "branch-b", now: NOW }).finalPoints,
    ).toBe(0);
    expect(
      evaluatePointRules([scoped], { sourceType: "PER_VISIT", branchId: "branch-a", now: NOW }).finalPoints,
    ).toBe(10);
  });
});

describe("evaluatePointRules — MULTIPLIER stacking (§11)", () => {
  const base = () => rule({ type: "PER_VISIT", config: { pointsPerVisit: 10 } });

  it("default HIGHEST_ONLY: multiple multipliers → max wins, not multiplied together", () => {
    const rules = [
      base(),
      rule({ role: "MODIFIER", type: "MULTIPLIER", config: { factor: 2 } }),
      rule({ role: "MODIFIER", type: "MULTIPLIER", config: { factor: 3 } }),
    ];
    const result = evaluatePointRules(rules, { sourceType: "PER_VISIT", branchId: null, now: NOW });
    expect(result.finalPoints).toBe(30); // 10 × max(2,3) = 30, NOT 10×2×3=60
  });

  it("opt-in MULTIPLICATIVE: factors multiply together", () => {
    const rules = [
      base(),
      rule({ role: "MODIFIER", type: "MULTIPLIER", stackingPolicy: "MULTIPLICATIVE", config: { factor: 2 } }),
      rule({ role: "MODIFIER", type: "MULTIPLIER", stackingPolicy: "MULTIPLICATIVE", config: { factor: 3 } }),
    ];
    const result = evaluatePointRules(rules, { sourceType: "PER_VISIT", branchId: null, now: NOW });
    expect(result.finalPoints).toBe(60); // 10 × 2 × 3 = 60
  });

  it("no active multiplier → effectiveMultiplier is 1 (no-op)", () => {
    const result = evaluatePointRules([base()], { sourceType: "PER_VISIT", branchId: null, now: NOW });
    expect(result.finalPoints).toBe(10);
  });
});

describe("evaluatePointRules — BONUS_EVENT (§11: always ADDITIVE)", () => {
  it("NEW_MEMBER bonus only applies when isNewMember is true", () => {
    const rules = [
      rule({ type: "PER_VISIT", config: { pointsPerVisit: 10 } }),
      rule({ role: "MODIFIER", type: "BONUS_EVENT", config: { event: "NEW_MEMBER", points: 20 } }),
    ];
    expect(
      evaluatePointRules(rules, { sourceType: "PER_VISIT", branchId: null, now: NOW, isNewMember: false })
        .finalPoints,
    ).toBe(10);
    expect(
      evaluatePointRules(rules, { sourceType: "PER_VISIT", branchId: null, now: NOW, isNewMember: true })
        .finalPoints,
    ).toBe(30);
  });

  it("bonus is NOT multiplied unless config.multipliable is true", () => {
    const rules = [
      rule({ type: "PER_VISIT", config: { pointsPerVisit: 10 } }),
      rule({ role: "MODIFIER", type: "MULTIPLIER", config: { factor: 3 } }),
      rule({
        role: "MODIFIER",
        type: "BONUS_EVENT",
        config: { event: "BIRTHDAY", points: 5, multipliable: false },
      }),
    ];
    const result = evaluatePointRules(rules, {
      sourceType: "PER_VISIT",
      branchId: null,
      now: NOW,
      isBirthday: true,
    });
    // finalPoints = round(10 × 3) + 5 = 35, not round((10+5) × 3) or (10×3)+(5×3)
    expect(result.finalPoints).toBe(35);
  });

  it("multipliable bonus IS scaled by the effective multiplier", () => {
    const rules = [
      rule({ type: "PER_VISIT", config: { pointsPerVisit: 10 } }),
      rule({ role: "MODIFIER", type: "MULTIPLIER", config: { factor: 3 } }),
      rule({
        role: "MODIFIER",
        type: "BONUS_EVENT",
        config: { event: "BIRTHDAY", points: 5, multipliable: true },
      }),
    ];
    const result = evaluatePointRules(rules, {
      sourceType: "PER_VISIT",
      branchId: null,
      now: NOW,
      isBirthday: true,
    });
    // finalPoints = round(10 × 3) + round(5 × 3) = 30 + 15 = 45
    expect(result.finalPoints).toBe(45);
  });

  it("multiple bonuses stack additively", () => {
    const rules = [
      rule({ type: "PER_VISIT", config: { pointsPerVisit: 10 } }),
      rule({ role: "MODIFIER", type: "BONUS_EVENT", config: { event: "NEW_MEMBER", points: 20 } }),
      rule({ role: "MODIFIER", type: "BONUS_EVENT", config: { event: "BIRTHDAY", points: 5 } }),
    ];
    const result = evaluatePointRules(rules, {
      sourceType: "PER_VISIT",
      branchId: null,
      now: NOW,
      isNewMember: true,
      isBirthday: true,
    });
    expect(result.finalPoints).toBe(35); // 10 + 20 + 5
  });
});

describe("evaluatePointRules — full formula (§11 pseudocode)", () => {
  it("finalPoints = round(basePoints × effectiveMultiplier) + bonusPoints", () => {
    const rules = [
      rule({ type: "PER_VISIT", config: { pointsPerVisit: 7 } }),
      rule({ role: "MODIFIER", type: "MULTIPLIER", config: { factor: 1.5 } }),
      rule({
        role: "MODIFIER",
        type: "BONUS_EVENT",
        config: { event: "NEW_MEMBER", points: 3, multipliable: false },
      }),
    ];
    const result = evaluatePointRules(rules, {
      sourceType: "PER_VISIT",
      branchId: null,
      now: NOW,
      isNewMember: true,
    });
    // round(7 × 1.5) + 3 = round(10.5) + 3 = 11 + 3 = 14 (banker's/half-up per Math.round)
    expect(result.finalPoints).toBe(14);
  });
});
