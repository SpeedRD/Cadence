/**
 * Pure calculation logic for the payday check-in / smart budget planner.
 * No I/O here - src/lib/data/payday.ts assembles the inputs from Prisma and
 * src/server/actions/payday.ts recomputes the same functions server-side
 * before persisting a confirmed plan, so the numbers a user sees are always
 * exactly what gets written.
 */
import { convert, type RateTable } from "@/lib/currency";
import { round2 } from "@/lib/money";

import type { PaydayCheckinDraft, PaydayGoalFundingDraft } from "@/lib/data/payday";

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

export interface PaydayDraftSummary {
  /** Every account's entered income converted into draft.displayCurrency. */
  totalIncome: number;
  goalPlanTotal: number;
  essentialFixedTotal: number;
  flexibleTotal: number;
  /** availableForFlexibleCategories() over the draft - negative when the plan is over-committed. */
  available: number;
}

/**
 * The headline figures for a check-in draft, in draft.displayCurrency. This is
 * the single place that turns a PaydayCheckinDraft into "available for
 * flexible categories": the Dashboard's confirmed check-in summary line and
 * the period hero's recommended overall budget both read it from here, so the
 * two can never disagree.
 */
export function summarizePaydayDraft(draft: PaydayCheckinDraft, rates: RateTable): PaydayDraftSummary {
  const totalIncome = round2(
    draft.accounts.reduce(
      (sum, a) => sum + convert(a.incomeEntered, a.currency, draft.displayCurrency, rates),
      0,
    ),
  );
  // Goal and category planned amounts are already in draft.displayCurrency.
  const goalPlanTotal = round2(draft.goals.reduce((sum, g) => sum + g.plannedAmount, 0));
  const essentialFixedTotal = round2(
    draft.essentialCategories.reduce((sum, c) => sum + c.plannedAmount, 0),
  );
  const flexibleTotal = round2(draft.flexibleCategories.reduce((sum, c) => sum + c.plannedAmount, 0));
  const available = availableForFlexibleCategories({
    income: totalIncome,
    includedCarryover: draft.includedCarryover,
    subscriptions: draft.subscriptionsTotal,
    recurringContributions: draft.contributionsTotal,
    goalPlan: goalPlanTotal,
    essentialFixed: essentialFixedTotal,
    buffer: draft.plannedBuffer,
  });
  return { totalIncome, goalPlanTotal, essentialFixedTotal, flexibleTotal, available };
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
  /** What the account still has to cover this period, in `currency` (the item's own): its occurrences not yet in the ledger. */
  nativeAmount: number;
  currency: string;
  /** Every owed occurrence is already paid this period, so counting it again would double-count it. */
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

export interface GoalFundingGoal {
  goalId: string;
  /** What the goal needs set aside this period, in the display currency - its roadmap recommendedAmount. */
  amount: number;
}

/** An account a goal can draw on. Structurally a subset of AccountBufferPlan, so the buffer view's rows can be passed straight in. */
export interface GoalFundingAccount {
  accountId: string;
  name: string;
  currency: string;
  /** What the account has to spare after its subscriptions and its own buffer, in its own currency: AccountBufferPlan.headroom, less whatever earlier goals already claimed. */
  headroom: number;
}

export interface GoalFundingDraw {
  accountId: string;
  name: string;
  currency: string;
  /** The room this goal could draw on here when it was reached, in the account's own currency. */
  headroom: number;
  /** This account's proportion of the room across every account with any, 0..1 - the reason for its share of the goal. */
  share: number;
  /** In the account's own currency. Never more than `headroom`. */
  recommendedAmount: number;
}

export interface GoalFundingPlan {
  goalId: string;
  /** What the goal needed, in the display currency. */
  amount: number;
  /** One row per account with room to spare, in the order the accounts were given. */
  draws: GoalFundingDraw[];
  /** The draws summed into the display currency. */
  recommendedTotal: number;
  /** amount - recommendedTotal when the room across every account could not cover the goal; 0 otherwise. Display currency. */
  shortfall: number;
}

/**
 * Where to draw one goal's amount from: each account with positive headroom
 * (what is left after its subscriptions and its own buffer - see
 * planAccountBuffers) takes a share proportional to its headroom, never more
 * than that headroom. When every account's room together is less than the goal
 * needs, each account gives all it has and the rest is reported as `shortfall`
 * rather than quietly planned from money that is not there.
 *
 * Shares are compared in the display currency and each draw is then expressed
 * in its account's own currency, the same way the buffer view compares rooms
 * across accounts. The cent left over by rounding the shares lands on the
 * account with the most room, so same-currency draws sum exactly to `amount`.
 */
export function recommendGoalFunding(
  goal: GoalFundingGoal,
  accounts: GoalFundingAccount[],
  options: { displayCurrency: string; rates: RateTable },
): GoalFundingPlan {
  const { displayCurrency, rates } = options;
  const amount = Math.max(0, goal.amount);
  const room = accounts
    .filter((account) => account.headroom > 0)
    .map((account) => ({
      account,
      displayHeadroom: convert(account.headroom, account.currency, displayCurrency, rates),
    }));
  const totalRoom = room.reduce((sum, entry) => sum + entry.displayHeadroom, 0);
  const toDraw = (entry: (typeof room)[number], recommendedAmount: number): GoalFundingDraw => ({
    accountId: entry.account.accountId,
    name: entry.account.name,
    currency: entry.account.currency,
    headroom: entry.account.headroom,
    share: totalRoom > 0 ? entry.displayHeadroom / totalRoom : 0,
    recommendedAmount,
  });

  let draws: GoalFundingDraw[];
  if (amount <= 0 || totalRoom <= 0) {
    draws = room.map((entry) => toDraw(entry, 0));
  } else if (amount >= totalRoom) {
    draws = room.map((entry) => toDraw(entry, entry.account.headroom));
  } else {
    const residualIndex = room.reduce(
      (best, entry, index) => (entry.displayHeadroom > room[best].displayHeadroom ? index : best),
      0,
    );
    const displayDraws = room.map((entry) => round2((amount * entry.displayHeadroom) / totalRoom));
    const others = displayDraws.reduce((sum, value, index) => (index === residualIndex ? sum : sum + value), 0);
    displayDraws[residualIndex] = Math.min(round2(amount - others), room[residualIndex].displayHeadroom);
    draws = room.map((entry, index) =>
      toDraw(
        entry,
        Math.min(entry.account.headroom, round2(convert(displayDraws[index], displayCurrency, entry.account.currency, rates))),
      ),
    );
  }

  const recommendedTotal = round2(
    draws.reduce((sum, draw) => sum + convert(draw.recommendedAmount, draw.currency, displayCurrency, rates), 0),
  );
  return {
    goalId: goal.goalId,
    amount,
    draws,
    recommendedTotal,
    shortfall: Math.max(0, round2(amount - recommendedTotal)),
  };
}

/**
 * recommendGoalFunding() for every goal in a check-in, sharing one pool of
 * headroom. Modeling choice: goals are funded in the order given - the order
 * the draft lists them, which is the order Step 3 shows them (oldest goal
 * first, see listGoals) - and each goal's recommended draw is taken out of
 * the running pool before the next goal is placed. So the first goal gets
 * first claim on every account's room and a later goal is recommended only
 * what is still unclaimed; two goals are never both pointed at the same
 * headroom. Whatever the user then edits a goal's rows to is not fed back
 * into the pool: a recommendation is a function of the draft alone, so
 * editing one goal never silently reshuffles another's.
 *
 * Every account with room before any goal is placed keeps a row on every
 * goal, at 0 once earlier goals have used it up, so a later goal can still be
 * funded from it by hand.
 */
export function planGoalFunding(
  goals: GoalFundingGoal[],
  accounts: GoalFundingAccount[],
  options: { displayCurrency: string; rates: RateTable },
): GoalFundingPlan[] {
  const eligible = accounts.filter((account) => account.headroom > 0);
  const remaining = new Map(eligible.map((account) => [account.accountId, account.headroom]));
  return goals.map((goal) => {
    const plan = recommendGoalFunding(
      goal,
      eligible.map((account) => ({ ...account, headroom: remaining.get(account.accountId) ?? 0 })),
      options,
    );
    const drawByAccount = new Map(plan.draws.map((draw) => [draw.accountId, draw]));
    for (const draw of plan.draws) {
      remaining.set(draw.accountId, round2((remaining.get(draw.accountId) ?? 0) - draw.recommendedAmount));
    }
    return {
      ...plan,
      draws: eligible.map(
        (account) =>
          drawByAccount.get(account.accountId) ?? {
            accountId: account.accountId,
            name: account.name,
            currency: account.currency,
            headroom: 0,
            share: 0,
            recommendedAmount: 0,
          },
      ),
    };
  });
}

/** One account's row in a goal's Step 3 breakdown: the live recommendation next to what the plan will draw from it. */
export interface GoalFundingRow extends GoalFundingDraw {
  /** What the plan draws from this account, in its own currency: the user's held figure, else the recommendation. */
  plannedAmount: number;
  /** The figure is the user's own (see PaydayGoalFundingDraft.held) rather than the live recommendation. */
  held: boolean;
}

export interface ResolvedGoalFunding {
  goalId: string;
  /** One row per account with room, in the plan's order. */
  rows: GoalFundingRow[];
  /** The rows' planned amounts summed into the display currency - the goal's total this period. */
  total: number;
  /** recommendGoalFunding()'s figures for the same goal, for the card's explanation. */
  recommendedTotal: number;
  shortfall: number;
}

/**
 * The rows Step 3 shows for one goal: every account the recommendation gives a
 * row (an account with room to spare), each at the user's held figure when
 * there is one and at the live recommendation otherwise. A held figure for an
 * account with no room now is neither shown nor counted, so what is on screen
 * is exactly what confirming writes.
 */
export function resolveGoalFunding(
  plan: GoalFundingPlan,
  funding: PaydayGoalFundingDraft[],
  options: { displayCurrency: string; rates: RateTable },
): ResolvedGoalFunding {
  const heldByAccount = new Map(
    funding.filter((row) => row.held).map((row) => [row.accountId, row.plannedAmount]),
  );
  const rows = plan.draws.map((draw) => {
    const held = heldByAccount.get(draw.accountId);
    return { ...draw, plannedAmount: held ?? draw.recommendedAmount, held: held !== undefined };
  });
  return {
    goalId: plan.goalId,
    rows,
    total: round2(
      rows.reduce(
        (sum, row) => sum + convert(row.plannedAmount, row.currency, options.displayCurrency, options.rates),
        0,
      ),
    ),
    recommendedTotal: plan.recommendedTotal,
    shortfall: plan.shortfall,
  };
}
