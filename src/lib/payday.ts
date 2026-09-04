/**
 * Pure calculation logic for the payday check-in / smart budget planner.
 * No I/O here - src/lib/data/payday.ts assembles the inputs from Prisma and
 * src/server/actions/payday.ts recomputes the same functions server-side
 * before persisting a confirmed plan, so the numbers a user sees are always
 * exactly what gets written.
 */
import { convert, type RateTable } from "@/lib/currency";
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

export interface AccountBufferAccount {
  accountId: string;
  name: string;
  currency: string;
  /** Income entered for this account in this check-in, in the account's own currency. */
  income: number;
  /** The configured buffer floor, converted to the account's own currency. */
  bufferFloor: number;
}

export interface AccountBufferSubscription {
  recurringItemId: string;
  /** The recurring item's funding account - null while it has none. */
  accountId: string | null;
  /** In `currency`, the recurring item's own currency. */
  nativeAmount: number;
  currency: string;
  /** Already paid this period, so posting it again would double-count it. */
  alreadyLogged: boolean;
}

/** One account's own protected buffer and how its due subscriptions sit against it. Every amount is in the account's own currency. */
export interface AccountBufferPlan {
  accountId: string;
  name: string;
  currency: string;
  income: number;
  /** This account's still-unpaid due subscriptions, converted to its currency. */
  subscriptionsTotal: number;
  /** defaultProtectedBuffer() applied to this account's income alone. */
  suggestedBuffer: number;
  /** income - subscriptionsTotal: what posting them all would leave. */
  remaining: number;
  /** remaining - suggestedBuffer. Negative means the buffer would be breached. */
  headroom: number;
  /** How far below its own buffer this account would land - 0 when it stays above. */
  shortfall: number;
  belowBuffer: boolean;
  /** The account with the most room to take a subscription over, when this one is short and another has any. */
  suggestedAccountId: string | null;
  suggestedAccountName: string | null;
  recurringItemIds: string[];
}

export interface AccountBufferBreakdown {
  /** One row per account with income entered, in the order the accounts were given. */
  accounts: AccountBufferPlan[];
  /** Due subscriptions funded by no account, or by one with no income this check-in - shown so they can still be reassigned. */
  unassignedRecurringItemIds: string[];
  /** Every account's suggested buffer summed into `displayCurrency` - the plan's single protectedBuffer figure. */
  total: number;
}

/**
 * The per-account view of the protected buffer: each account's own suggested
 * buffer (the same defaultProtectedBuffer() formula applied to that account's
 * income instead of the total) measured against the subscriptions it funds.
 *
 * Buffers are computed and summed in each account's own currency; only the
 * cross-account comparison (which account has the most room) and `total` go
 * through the display currency, the same way every other cross-currency sum in
 * the planner does.
 */
export function planAccountBuffers(
  accounts: AccountBufferAccount[],
  subscriptions: AccountBufferSubscription[],
  options: { bufferPercent: number; displayCurrency: string; rates: RateTable },
): AccountBufferBreakdown {
  const { bufferPercent, displayCurrency, rates } = options;
  const funded = accounts.filter((account) => account.income > 0);
  const fundedIds = new Set(funded.map((account) => account.accountId));

  const plans: AccountBufferPlan[] = funded.map((account) => {
    const own = subscriptions.filter((s) => s.accountId === account.accountId);
    // Already-paid items are excluded from the total for the same reason the
    // step's subscriptions total excludes them: that money is already gone,
    // counting it again would invent a shortfall.
    const subscriptionsTotal = round2(
      own
        .filter((s) => !s.alreadyLogged)
        .reduce((sum, s) => sum + convert(s.nativeAmount, s.currency, account.currency, rates), 0),
    );
    const suggestedBuffer = defaultProtectedBuffer(account.income, bufferPercent, account.bufferFloor);
    const remaining = round2(account.income - subscriptionsTotal);
    const headroom = round2(remaining - suggestedBuffer);
    return {
      accountId: account.accountId,
      name: account.name,
      currency: account.currency,
      income: account.income,
      subscriptionsTotal,
      suggestedBuffer,
      remaining,
      headroom,
      shortfall: headroom < 0 ? round2(-headroom) : 0,
      belowBuffer: headroom < 0,
      suggestedAccountId: null,
      suggestedAccountName: null,
      recurringItemIds: own.map((s) => s.recurringItemId),
    };
  });

  const displayHeadroom = new Map(
    plans.map((plan) => [plan.accountId, convert(plan.headroom, plan.currency, displayCurrency, rates)]),
  );
  for (const plan of plans) {
    if (!plan.belowBuffer) continue;
    const alternative = plans
      .filter((other) => other.accountId !== plan.accountId && (displayHeadroom.get(other.accountId) ?? 0) > 0)
      .sort((a, b) => (displayHeadroom.get(b.accountId) ?? 0) - (displayHeadroom.get(a.accountId) ?? 0))[0];
    if (!alternative) continue;
    plan.suggestedAccountId = alternative.accountId;
    plan.suggestedAccountName = alternative.name;
  }

  return {
    accounts: plans,
    unassignedRecurringItemIds: subscriptions
      .filter((s) => !s.accountId || !fundedIds.has(s.accountId))
      .map((s) => s.recurringItemId),
    total: round2(
      plans.reduce(
        (sum, plan) => sum + convert(plan.suggestedBuffer, plan.currency, displayCurrency, rates),
        0,
      ),
    ),
  };
}
