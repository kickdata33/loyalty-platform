import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { writeAuditLog } from "@/modules/audit/service";
import type { AppliedRule, PointRule, PointRuleConfig, PointRuleType } from "@/modules/points/types";
import { requirePermission } from "@/modules/rbac/authorization-service";
import { PERMISSIONS } from "@/modules/rbac/permission-matrix";
import { ValidationError } from "@/modules/shared/errors";
import { COLLECTIONS, getDb } from "@/modules/shared/firestore";
import type { AuthContext } from "@/modules/shared/types";

/**
 * Points Rules — CRUD + the Rule Stacking Algorithm (FINAL-ARCHITECTURE.md §11).
 *
 * Rule config CRUD is gated by `MERCHANT_SETTINGS_MANAGE` (Owner+Manager, §9) — there is no
 * separate "manage points rules" permission in the LOCKED Permission Matrix V1, so this reuses
 * the existing merchant-settings permission rather than inventing a new one (same precedent as
 * branding/branches in Phase 2). Reading the active rule list uses `POINTS_VIEW_HISTORY` (every
 * role has it) since Staff legitimately needs to know what's active to explain it to customers.
 */

const VALID_TYPES: readonly PointRuleType[] = [
  "PER_UNIT",
  "PER_VISIT",
  "AMOUNT_BASED",
  "BONUS_EVENT",
  "MULTIPLIER",
];

export interface CreatePointRuleInput {
  name: string;
  type: PointRuleType;
  branchScope?: string[];
  startAt?: Date | null;
  endAt?: Date | null;
  priority?: number;
  stackingPolicy?: "ADDITIVE" | "HIGHEST_ONLY" | "MULTIPLICATIVE";
  config: PointRuleConfig;
}

function roleForType(type: PointRuleType): "BASE" | "MODIFIER" {
  return type === "PER_UNIT" || type === "PER_VISIT" || type === "AMOUNT_BASED" ? "BASE" : "MODIFIER";
}

function defaultStackingPolicy(type: PointRuleType): "ADDITIVE" | "HIGHEST_ONLY" | "MULTIPLICATIVE" {
  // §11: MULTIPLIER default HIGHEST_ONLY (opt-in MULTIPLICATIVE); BONUS_EVENT always ADDITIVE.
  if (type === "MULTIPLIER") return "HIGHEST_ONLY";
  return "ADDITIVE";
}

function validateConfig(type: PointRuleType, config: PointRuleConfig): void {
  switch (type) {
    case "PER_UNIT":
      if (config.unit !== "HOUR" && config.unit !== "MINUTE") {
        throw new ValidationError("PER_UNIT rules require config.unit = 'HOUR' | 'MINUTE'.");
      }
      if (typeof config.pointsPerUnit !== "number" || config.pointsPerUnit <= 0) {
        throw new ValidationError("PER_UNIT rules require a positive config.pointsPerUnit.");
      }
      break;
    case "PER_VISIT":
      if (typeof config.pointsPerVisit !== "number" || config.pointsPerVisit <= 0) {
        throw new ValidationError("PER_VISIT rules require a positive config.pointsPerVisit.");
      }
      break;
    case "AMOUNT_BASED":
      // §11: "เตรียมไว้ ยังไม่ใช้จริงจนมี trusted amount source" — schema accepted, never
      // evaluated by evaluatePointRules() below (no BASE branch reads it).
      break;
    case "BONUS_EVENT":
      if (config.event !== "NEW_MEMBER" && config.event !== "BIRTHDAY") {
        throw new ValidationError("BONUS_EVENT rules require config.event = 'NEW_MEMBER' | 'BIRTHDAY'.");
      }
      if (typeof config.points !== "number" || config.points <= 0) {
        throw new ValidationError("BONUS_EVENT rules require a positive config.points.");
      }
      break;
    case "MULTIPLIER":
      if (typeof config.factor !== "number" || config.factor <= 0) {
        throw new ValidationError("MULTIPLIER rules require a positive config.factor.");
      }
      break;
  }
}

export async function createPointRule(ctx: AuthContext, input: CreatePointRuleInput): Promise<string> {
  requirePermission(ctx, PERMISSIONS.MERCHANT_SETTINGS_MANAGE, ctx.merchantId);
  if (!VALID_TYPES.includes(input.type)) throw new ValidationError(`Invalid rule type: ${input.type}`);
  if (input.name.trim().length === 0) throw new ValidationError("name must not be empty.");
  validateConfig(input.type, input.config);

  const stackingPolicy = input.stackingPolicy ?? defaultStackingPolicy(input.type);
  if (input.type === "BONUS_EVENT" && stackingPolicy !== "ADDITIVE") {
    throw new ValidationError("BONUS_EVENT rules must use stackingPolicy 'ADDITIVE' (§11).");
  }

  const ref = getDb().collection(COLLECTIONS.pointRules).doc();
  await ref.set({
    merchantId: ctx.merchantId,
    name: input.name,
    enabled: true,
    type: input.type,
    role: roleForType(input.type),
    branchScope: input.branchScope ?? [],
    startAt: input.startAt ? Timestamp.fromDate(input.startAt) : null,
    endAt: input.endAt ? Timestamp.fromDate(input.endAt) : null,
    priority: input.priority ?? 100,
    stackingPolicy,
    config: input.config,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: "pointRule.created",
    targetType: "pointRule",
    targetId: ref.id,
    after: { name: input.name, type: input.type },
  });

  return ref.id;
}

export async function setPointRuleEnabled(
  ctx: AuthContext,
  ruleId: string,
  enabled: boolean,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.MERCHANT_SETTINGS_MANAGE, ctx.merchantId);
  const ref = getDb().collection(COLLECTIONS.pointRules).doc(ruleId);
  const snap = await ref.get();
  if (!snap.exists) throw new ValidationError(`Point rule ${ruleId} not found.`);
  const data = snap.data() as PointRule;
  if (data.merchantId !== ctx.merchantId) {
    // Same load-then-authorize pattern as every other resource lookup (§10).
    requirePermission(ctx, PERMISSIONS.MERCHANT_SETTINGS_MANAGE, data.merchantId);
  }

  await ref.update({ enabled, updatedAt: FieldValue.serverTimestamp() });
  await writeAuditLog({
    merchantId: ctx.merchantId,
    actorType: "staff",
    actorId: ctx.authUid,
    action: enabled ? "pointRule.enabled" : "pointRule.disabled",
    targetType: "pointRule",
    targetId: ruleId,
    before: { enabled: data.enabled },
    after: { enabled },
  });
}

export async function listPointRules(ctx: AuthContext): Promise<PointRule[]> {
  requirePermission(ctx, PERMISSIONS.POINTS_VIEW_HISTORY, ctx.merchantId);
  const snap = await getDb()
    .collection(COLLECTIONS.pointRules)
    .where("merchantId", "==", ctx.merchantId)
    .get();
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as Omit<PointRule, "id">) }));
}

// --- Rule Stacking Algorithm (§11, deterministic) -----------------------------------------

export interface RuleEvaluationInput {
  /** Which BASE rule type this earn event matches. */
  sourceType: "PER_UNIT" | "PER_VISIT";
  units?: number; // for PER_UNIT
  branchId: string | null;
  now: Date;
  isNewMember?: boolean;
  isBirthday?: boolean;
}

function isRuleActive(rule: PointRule, now: Date): boolean {
  if (!rule.enabled) return false;
  if (rule.startAt && rule.startAt.toDate() > now) return false;
  if (rule.endAt && rule.endAt.toDate() < now) return false;
  return true;
}

function ruleAppliesToBranch(rule: PointRule, branchId: string | null): boolean {
  if (rule.branchScope.length === 0) return true; // empty = all branches (§11)
  return branchId !== null && rule.branchScope.includes(branchId);
}

function computeBasePoints(rule: PointRule, input: RuleEvaluationInput): number {
  if (rule.type === "PER_VISIT") return rule.config.pointsPerVisit ?? 0;
  if (rule.type === "PER_UNIT") {
    const units = input.units ?? 0;
    return Math.max(0, units) * (rule.config.pointsPerUnit ?? 0);
  }
  return 0; // AMOUNT_BASED never evaluated in V1 (§11)
}

function bonusEventMatches(rule: PointRule, input: RuleEvaluationInput): boolean {
  if (rule.config.event === "NEW_MEMBER") return input.isNewMember === true;
  if (rule.config.event === "BIRTHDAY") return input.isBirthday === true;
  return false;
}

/**
 * Deterministic Rule Stacking Algorithm (§11):
 *
 *   basePoints = evaluate(matched BASE rule)
 *   effectiveMultiplier = HIGHEST_ONLY: max(...) | MULTIPLICATIVE: product(...)
 *   bonusPoints = Σ matched BONUS_EVENT rules (× effectiveMultiplier iff rule.config.multipliable)
 *   finalPoints = round(basePoints × effectiveMultiplier) + bonusPoints
 *
 * Pure function — no I/O, fully unit-testable without the emulator.
 */
export function evaluatePointRules(
  rules: PointRule[],
  input: RuleEvaluationInput,
): { finalPoints: number; appliedRules: AppliedRule[] } {
  const active = rules.filter((r) => isRuleActive(r, input.now) && ruleAppliesToBranch(r, input.branchId));

  const baseCandidates = active
    .filter((r) => r.role === "BASE" && r.type === input.sourceType)
    .sort((a, b) => a.priority - b.priority); // lower priority number wins on config conflicts
  const base = baseCandidates[0];
  const basePoints = base ? computeBasePoints(base, input) : 0;

  const multipliers = active.filter((r) => r.role === "MODIFIER" && r.type === "MULTIPLIER");
  const highestOnly = multipliers.filter((r) => r.stackingPolicy !== "MULTIPLICATIVE");
  const multiplicative = multipliers.filter((r) => r.stackingPolicy === "MULTIPLICATIVE");

  let effectiveMultiplier = 1;
  if (highestOnly.length > 0) {
    effectiveMultiplier = Math.max(...highestOnly.map((r) => r.config.factor ?? 1));
  }
  for (const r of multiplicative) {
    effectiveMultiplier *= r.config.factor ?? 1;
  }

  const bonuses = active.filter(
    (r) => r.role === "MODIFIER" && r.type === "BONUS_EVENT" && bonusEventMatches(r, input),
  );

  const appliedRules: AppliedRule[] = [];
  if (base) appliedRules.push({ ruleId: base.id, ruleName: base.name, contribution: basePoints });

  let bonusPoints = 0;
  for (const r of bonuses) {
    const raw = r.config.points ?? 0;
    const contribution = r.config.multipliable ? Math.round(raw * effectiveMultiplier) : raw;
    bonusPoints += contribution;
    appliedRules.push({ ruleId: r.id, ruleName: r.name, contribution });
  }

  const finalPoints = Math.round(basePoints * effectiveMultiplier) + bonusPoints;
  return { finalPoints, appliedRules };
}
