/**
 * Pure calculation logic for the payday check-in / smart budget planner.
 * No I/O here - src/lib/data/payday.ts assembles the inputs from Prisma and
 * src/server/actions/payday.ts recomputes the same functions server-side
 * before persisting a confirmed plan, so the numbers a user sees are always
 * exactly what gets written.
 */
import { round2 } from "@/lib/money";

/** max(bufferPercent% of this check-in's income, the configured floor). Never zero unless the floor itself is zero. */
export function defaultProtectedBuffer(
  incomeTotal: number,
  bufferPercent: number,
  floorAmount: number,
): number {
  const percentOfIncome = (Math.max(0, incomeTotal) * bufferPercent) / 100;
  return round2(Math.max(percentOfIncome, floorAmount));
}

export interface FlexibleInput {
  income: number;
  includedCarryover: number;
  subscriptions: number;
  recurringContributions: number;
  goalPlan: number;
  essentialFixed: number;
  buffer: number;
}

/**
 * availableForFlexibleCategories = income + carryover - subscriptions -
 * recurringContributions - goalPlan - essentialFixed - buffer. Can be
 * negative - callers must show that as a deficit, never clamp it to zero.
 */
export function availableForFlexibleCategories(input: FlexibleInput): number {
  return round2(
    input.income +
      input.includedCarryover -
      input.subscriptions -
      input.recurringContributions -
      input.goalPlan -
      input.essentialFixed -
      input.buffer,
  );
}

export interface FlexibleSuggestion {
  id: string;
  suggested: number;
}

export interface ScaledFlexibleSuggestion extends FlexibleSuggestion {
  scaled: number;
}

/**
 * Scales suggested flexible-category amounts down proportionally so they never
 * sum past `available`. If available <= 0, every suggestion scales to 0 - the
 * planner must not suggest spending money that doesn't exist. If the raw
 * suggestions already fit, they pass through unscaled.
 */
export function scaleFlexibleSuggestions(
  suggestions: FlexibleSuggestion[],
  available: number,
): ScaledFlexibleSuggestion[] {
  if (available <= 0) {
    return suggestions.map((s) => ({ ...s, scaled: 0 }));
  }
  const total = suggestions.reduce((sum, s) => sum + s.suggested, 0);
  if (total <= available || total === 0) {
    return suggestions.map((s) => ({ ...s, scaled: round2(s.suggested) }));
  }
  const factor = available / total;
  return suggestions.map((s) => ({ ...s, scaled: round2(s.suggested * factor) }));
}
