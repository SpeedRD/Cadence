/**
 * Pure simulation for the debt payoff comparator on the Goals page: given the
 * goals marked as debts, in which order does each get paid off under the two
 * data-light strategies, and when?
 *
 *   avalanche   the extra goes to the largest remaining balance first
 *   snowball    the extra goes to the smallest remaining balance first
 *
 * Cadence holds no interest rates, so these are the balance-ordered variants
 * of both strategies; each needs only a debt's own remaining balance.
 *
 * No I/O here. src/lib/data/debt-payoff.ts assembles the inputs - each debt's
 * remaining balance and its own per-period pace, the roadmap figure the goal
 * page already shows - and the Goals page runs the comparison for whatever
 * extra amount the user types. It is exploratory only: nothing here feeds the
 * payday check-in's goal funding, and nothing here is written.
 *
 * Each period, every debt still open receives its own minimum (its pace), and
 * the extra goes entirely to the next debt in the strategy's order. A minimum
 * larger than what its debt has left spills the rest onto that pool in the
 * same period. Once a debt is paid off its minimum is freed and folds into
 * the pool for every later period - the rollover that is the point of both
 * strategies. Because the whole flow (the extra plus every minimum) reaches
 * the debts every period either way, both orders finish in the same number of
 * periods; only which debt finishes when differs, and that is what the page
 * shows side by side. Neither order is ranked.
 */
export type DebtStrategy = "avalanche" | "snowball";

/**
 * How far the simulation looks: 600 pay periods is 25 years. A run still
 * unfinished by then reports no total rather than walking on.
 */
export const MAX_DEBT_PERIODS = 600;

/** With one debt there is no order to compare; the Goals page shows nothing below this. */
export const MIN_DEBTS_TO_COMPARE = 2;

export interface DebtInput {
  goalId: string;
  name: string;
  /** What is still owed, in the display currency. */
  balance: number;
  /**
   * What the debt receives on its own every period, in the display
   * currency - its roadmap pace this period. 0 for a debt with no pace of
   * its own (no target date), which is then paid only by the extra and by
   * the minimums other debts free up.
   */
  minimum: number;
}

/** One debt reaching zero: the period (1 = the plan period) it did so in. */
export interface DebtPayoff {
  goalId: string;
  name: string;
  period: number;
}

export interface DebtPayoffResult<T extends DebtInput = DebtInput> {
  strategy: DebtStrategy;
  /** The debts in the order this strategy directs the extra to them (the very rows given, so a caller's extra fields ride along); debts already at zero are left out. */
  order: T[];
  /** Each debt's payoff, in the order they happened (ties in period order). Only the debts that finished within MAX_DEBT_PERIODS. */
  payoffs: DebtPayoff[];
  /** Periods until every debt is paid off; 0 with no debts, null when it does not happen within MAX_DEBT_PERIODS. */
  totalPeriods: number | null;
}

export interface DebtStrategyComparison<T extends DebtInput = DebtInput> {
  avalanche: DebtPayoffResult<T>;
  snowball: DebtPayoffResult<T>;
  /** The extra plus every minimum: what reaches the debts each period under either order. */
  perPeriodFlow: number;
}

function toCents(amount: number): number {
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
}

/**
 * The strategy's order: largest balance first for avalanche, smallest first
 * for snowball. A stable sort, so equal balances keep the input order, and a
 * debt with nothing left is not a debt to order.
 */
export function orderDebts<T extends DebtInput>(debts: readonly T[], strategy: DebtStrategy): T[] {
  const open = debts.filter((debt) => toCents(debt.balance) > 0);
  return open.sort((a, b) =>
    strategy === "avalanche" ? toCents(b.balance) - toCents(a.balance) : toCents(a.balance) - toCents(b.balance),
  );
}

export function simulateDebtPayoff<T extends DebtInput>(
  debts: readonly T[],
  strategy: DebtStrategy,
  extraPerPeriod: number,
): DebtPayoffResult<T> {
  const order = orderDebts(debts, strategy);
  const extra = Math.max(0, toCents(extraPerPeriod));
  const balances = order.map((debt) => toCents(debt.balance));
  const minimums = order.map((debt) => Math.max(0, toCents(debt.minimum)));
  const done = order.map(() => false);
  const payoffs: DebtPayoff[] = [];

  // Nothing flowing means nothing is ever paid; say so rather than walk to
  // the horizon.
  const flow = extra + minimums.reduce((sum, minimum) => sum + minimum, 0);
  if (order.length > 0 && flow === 0) return { strategy, order, payoffs, totalPeriods: null };

  let freed = 0;
  let period = 0;
  while (payoffs.length < order.length && period < MAX_DEBT_PERIODS) {
    period += 1;
    let pool = extra + freed;

    // Every open debt receives its own minimum first; whatever a minimum
    // cannot use (the debt had less left than that) joins this period's pool.
    for (let i = 0; i < order.length; i += 1) {
      if (done[i]) continue;
      const paid = Math.min(minimums[i], balances[i]);
      balances[i] -= paid;
      pool += minimums[i] - paid;
    }

    // The pool - the extra, the freed minimums and any spill - goes to the
    // next open debt in the strategy's order, then the next.
    for (let i = 0; i < order.length && pool > 0; i += 1) {
      if (done[i] || balances[i] === 0) continue;
      const paid = Math.min(pool, balances[i]);
      balances[i] -= paid;
      pool -= paid;
    }

    for (let i = 0; i < order.length; i += 1) {
      if (done[i] || balances[i] !== 0) continue;
      done[i] = true;
      payoffs.push({ goalId: order[i].goalId, name: order[i].name, period });
      // Freed from the next period on: this period's pool was built before
      // the debt reached zero.
      freed += minimums[i];
    }
  }

  return {
    strategy,
    order,
    payoffs,
    totalPeriods: payoffs.length === order.length ? period : null,
  };
}

/** Both strategies on the same debts and extra, side by side. */
export function compareDebtStrategies<T extends DebtInput>(
  debts: readonly T[],
  extraPerPeriod: number,
): DebtStrategyComparison<T> {
  const extra = Math.max(0, toCents(extraPerPeriod));
  const flow =
    extra +
    orderDebts(debts, "avalanche").reduce((sum, debt) => sum + Math.max(0, toCents(debt.minimum)), 0);
  return {
    avalanche: simulateDebtPayoff(debts, "avalanche", extraPerPeriod),
    snowball: simulateDebtPayoff(debts, "snowball", extraPerPeriod),
    perPeriodFlow: flow / 100,
  };
}
