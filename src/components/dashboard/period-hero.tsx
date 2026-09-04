import Link from "next/link";

import { Meter, meterStatus } from "@/components/meter";
import { Money } from "@/components/money";
import { PeriodRail } from "@/components/period-rail";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { formatDayMonth } from "@/lib/date";
import type { Dictionary } from "@/lib/i18n";
import { periodKey } from "@/lib/period";

import type { PeriodSummary } from "@/lib/data/period-summary";

export function PeriodHero({
  summary,
  elapsed,
  suggestedBudget = null,
  t,
}: {
  summary: PeriodSummary;
  elapsed: number;
  /**
   * "Available for flexible categories" from this period's confirmed payday
   * check-in, in summary.currency, or null when there is no confirmed check-in
   * for this period or an overall budget is already set. May be zero or
   * negative - shown as a shortfall, and then not carried to the budget form.
   */
  suggestedBudget?: number | null;
  t: Dictionary["dashboard"];
}) {
  const { period, currency } = summary;
  const used = summary.periodBudget > 0 ? summary.spent / summary.periodBudget : 0;
  const carriesSuggestion = suggestedBudget !== null && suggestedBudget > 0;
  // `suggested` is read by src/app/(app)/budgets/page.tsx to pre-fill (never
  // save) the overall budget field. A zero/negative figure is shown above but
  // not carried: the budget form rejects negatives and 0 would be a real budget.
  const setBudgetHref = carriesSuggestion
    ? `/budgets?${new URLSearchParams({
        period: periodKey(period),
        suggested: suggestedBudget.toFixed(2),
      })}`
    : "/budgets";

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="grid gap-8 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="eyebrow">
                {t.periodPrefix} {period.period} · {period.longLabel}
              </p>
              <p className="text-xs text-muted-foreground">
                {summary.daysRemaining === 0
                  ? t.closed
                  : t.daysLeftOfTotal(summary.daysRemaining, period.totalDays)}
              </p>
            </div>
            <PeriodRail totalDays={period.totalDays} elapsed={elapsed} />
            <div className="flex justify-between text-[0.6875rem] text-muted-foreground">
              <span>{formatDayMonth(period.start)}</span>
              <span>{formatDayMonth(period.end)}</span>
            </div>
          </div>

          {summary.hasBudget ? (
            <div className="space-y-2">
              <p className="eyebrow">{t.safeToSpendPerDay}</p>
              <p className="figure figure-xl text-5xl leading-none font-medium">
                {formatMoney(summary.safeToSpendPerDay, currency)}
              </p>
              <p className="text-sm text-muted-foreground">
                {summary.safeToSpend >= 0 ? (
                  <>
                    <Money amount={summary.safeToSpend} currency={currency} />{" "}
                    {t.leftForRest}
                  </>
                ) : (
                  <>
                    <Money
                      amount={Math.abs(summary.safeToSpend)}
                      currency={currency}
                      className="text-[var(--critical)]"
                    />{" "}
                    {t.overThePlan}
                  </>
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="eyebrow">{t.safeToSpendPerDay}</p>
              <p className="text-sm text-muted-foreground">
                {t.setBudgetPrompt}
              </p>
              {suggestedBudget !== null ? (
                <p
                  className={
                    carriesSuggestion
                      ? "text-sm font-medium"
                      : "text-sm font-medium text-[var(--critical)]"
                  }
                >
                  {carriesSuggestion
                    ? t.recommendedBudget(formatMoney(suggestedBudget, currency))
                    : t.recommendedShortfall(formatMoney(suggestedBudget, currency))}
                </p>
              ) : null}
              <Button asChild size="sm">
                <Link href={setBudgetHref}>{t.setPeriodBudget}</Link>
              </Button>
            </div>
          )}
        </div>

        <div className="grid gap-5 border-t border-border/70 pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="eyebrow">{t.spent}</p>
              <p className="text-xs text-muted-foreground tnum">
                {summary.periodBudget > 0
                  ? t.percentOfBudget(Math.round(used * 100))
                  : t.noBudget}
              </p>
            </div>
            <p className="figure figure-lg text-2xl">
              {formatMoney(summary.spent, currency)}
            </p>
            {summary.totalSpent > summary.spent ? (
              <p className="text-[0.6875rem] text-muted-foreground">
                {t.plusOutsideBudget(
                  formatMoney(summary.totalSpent - summary.spent, currency),
                )}
              </p>
            ) : null}
            <Meter
              value={summary.spent}
              max={summary.periodBudget}
              status={
                summary.periodBudget > 0
                  ? meterStatus(summary.spent, summary.periodBudget)
                  : "neutral"
              }
            />
            <p className="text-xs text-muted-foreground">
              {t.ofBudgeted(formatMoney(summary.periodBudget, currency))}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
            <div className="space-y-1">
              <dt className="eyebrow">{t.committed}</dt>
              <dd className="figure text-base">
                {formatMoney(summary.committed, currency)}
              </dd>
              <p className="text-[0.6875rem] text-muted-foreground">
                {t.itemsDueBefore(summary.committedItems.length, formatDayMonth(period.end))}
              </p>
            </div>
            <div className="space-y-1">
              <dt className="eyebrow">{t.income}</dt>
              <dd className="figure text-base">
                {formatMoney(summary.income, currency)}
              </dd>
              <p className="text-[0.6875rem] text-muted-foreground">
                {t.loggedThisPeriod}
              </p>
            </div>
          </dl>
        </div>
      </div>
    </Card>
  );
}
