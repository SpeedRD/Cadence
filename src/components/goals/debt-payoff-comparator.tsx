"use client";

import { useState } from "react";

import { ExploratoryBadge } from "@/components/exploratory-badge";
import { Field } from "@/components/form/field";
import { PaydayAmountInput } from "@/components/payday/amount-input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { formatDate } from "@/lib/date";
import {
  MAX_DEBT_PERIODS,
  compareDebtStrategies,
  type DebtInput,
  type DebtPayoffResult,
} from "@/lib/debt-payoff";
import { getDictionary, type Locale } from "@/lib/i18n";
import { nextPeriod, parsePeriodKey, periodInfo, type PeriodRef } from "@/lib/period";

/** One debt as the page hands it over: the simulation's input plus its target date, serialised. */
export interface DebtGoalRow extends DebtInput {
  /** "YYYY-MM-DD", or null for a debt with no target date (and so no pace of its own). */
  targetDate: string | null;
}

/**
 * The Goals page's side-by-side of the two payoff orders, run in the browser
 * on the same pure function the harness checks, for whatever extra amount is
 * typed. Exploratory and read-only, like Afford: nothing here is saved, and
 * nothing here feeds the payday check-in's goal funding. Both orders are
 * presented the same way - the numbers are the comparison, and neither is
 * called anything the other is not.
 */
export function DebtPayoffComparator({
  debts,
  currency,
  planPeriod,
  locale,
}: {
  debts: DebtGoalRow[];
  /** The display currency every figure is in. */
  currency: string;
  /** The plan period's key ("2026-09-B"): period 1 of the simulation, the one each pace was computed for. */
  planPeriod: string;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.goals;
  const [extra, setExtra] = useState(0);
  const comparison = compareDebtStrategies(debts, extra);
  const planRef = parsePeriodKey(planPeriod);

  // The calendar end of simulation period n, walked from the plan period.
  const periodEnd = (n: number): string => {
    if (!planRef) return "";
    let cursor: PeriodRef = planRef;
    for (let i = 1; i < n; i += 1) cursor = nextPeriod(cursor);
    return formatDate(periodInfo(cursor).end);
  };

  // The total is order-invariant (see simulateDebtPayoff), so either result's
  // figure is the figure.
  const totalPeriods = comparison.avalanche.totalPeriods;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.debtComparatorTitle}</CardTitle>
        <CardDescription>{t.debtComparatorDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ExploratoryBadge note={dictionary.common.exploratoryNote(t.debtComparatorSubject)} />
        <div className="grid gap-3 sm:grid-cols-[220px_minmax(0,1fr)] sm:items-end">
          <Field label={t.extraPerPeriodLabel(currency)} htmlFor="debt-extra">
            <PaydayAmountInput
              id="debt-extra"
              value={extra}
              onChange={(value) => setExtra(Math.max(0, value))}
            />
          </Field>
          <p className="text-sm text-muted-foreground sm:pb-2">
            {t.debtFlowPerPeriod(formatMoney(comparison.perPeriodFlow, currency))}
          </p>
        </div>

        <p className="text-sm">
          {comparison.perPeriodFlow === 0
            ? t.debtNothingFlowing
            : totalPeriods === null
              ? t.debtBeyondHorizon(MAX_DEBT_PERIODS)
              : t.debtFreeAfter(totalPeriods, periodEnd(totalPeriods))}
        </p>

        <div className="grid gap-4 md:grid-cols-2">
          <StrategyColumn
            title={t.avalancheTitle}
            subtitle={t.avalancheSubtitle}
            result={comparison.avalanche}
            currency={currency}
            periodEnd={periodEnd}
            locale={locale}
          />
          <StrategyColumn
            title={t.snowballTitle}
            subtitle={t.snowballSubtitle}
            result={comparison.snowball}
            currency={currency}
            periodEnd={periodEnd}
            locale={locale}
          />
        </div>

        <p className="text-xs text-muted-foreground">{t.debtSameTotalNote}</p>
      </CardContent>
    </Card>
  );
}

function StrategyColumn({
  title,
  subtitle,
  result,
  currency,
  periodEnd,
  locale,
}: {
  title: string;
  subtitle: string;
  result: DebtPayoffResult<DebtGoalRow>;
  currency: string;
  periodEnd: (n: number) => string;
  locale: Locale;
}) {
  const t = getDictionary(locale).goals;
  return (
    <section
      aria-label={title}
      data-strategy={result.strategy}
      className="space-y-3 rounded-lg border border-border p-4"
    >
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <ol className="space-y-3">
        {result.order.map((debt, index) => {
          const payoff = result.payoffs.find((row) => row.goalId === debt.goalId);
          return (
            <li key={debt.goalId} className="flex gap-3">
              <span className="figure w-4 shrink-0 pt-0.5 text-xs text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium">{debt.name}</span>
                  <span className="figure text-sm">{formatMoney(debt.balance, currency)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  {debt.targetDate ? t.debtPace(formatMoney(debt.minimum, currency)) : t.debtNoPace}
                </p>
                <p className="text-xs">
                  {payoff
                    ? t.debtPaidOffIn(payoff.period, periodEnd(payoff.period))
                    : t.debtNotWithinHorizon(MAX_DEBT_PERIODS)}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
