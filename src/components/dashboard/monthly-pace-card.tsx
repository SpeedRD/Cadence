import { EmptyState, Stat } from "@/components/stat";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";

import type { MonthlyPaceCardData } from "@/lib/data/monthly";

/**
 * Calendar-month companion to the pay-period safe-to-spend card above it:
 * "how does this month compare to my usual spending?" rather than "what can I
 * spend before the next pay?". Never replaces PeriodHero.
 */
export function MonthlyPaceCard({
  data,
  displayCurrency,
  t,
}: {
  data: MonthlyPaceCardData;
  displayCurrency: string;
  t: Dictionary["monthlyPace"];
}) {
  const { pace, history, comparison } = data;
  const money = (amount: number) => formatMoney(amount, displayCurrency);
  const totalOutflow = pace.projectedNormalSpending + pace.savingsInvestingSoFar;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t.title}</CardTitle>
        <CardDescription>{data.window.longLabel}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!history.sufficient ? (
          <EmptyState
            title={t.insufficientHistoryTitle}
            description={t.insufficientHistoryDescription(history.monthsUsed)}
          />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Stat
                label={t.projected}
                value={money(pace.projectedNormalSpending)}
                hint={t.dayOfMonth(pace.daysElapsed, pace.window.totalDays)}
              />
              <Stat label={t.average} value={money(history.averageNormalSpending)} />
            </div>

            {comparison ? (
              <p className="text-sm text-muted-foreground">
                {comparison.direction === "above"
                  ? t.aboveAverage(money(comparison.amount))
                  : comparison.direction === "below"
                    ? t.belowAverage(money(comparison.amount))
                    : t.onPace}
              </p>
            ) : null}

            <dl className="grid grid-cols-3 gap-3 border-t border-border/70 pt-3">
              <div className="space-y-1">
                <dt className="eyebrow">{t.lifestyle}</dt>
                <dd className="figure text-sm">{money(pace.projectedLifestyle)}</dd>
              </div>
              <div className="space-y-1">
                <dt className="eyebrow">{t.committed}</dt>
                <dd className="figure text-sm">
                  {money(pace.committedSpentSoFar + pace.committedStillDueThisMonth)}
                </dd>
              </div>
              <div className="space-y-1">
                <dt className="eyebrow">{t.savings}</dt>
                <dd className="figure text-sm">{money(pace.savingsInvestingSoFar)}</dd>
              </div>
            </dl>

            <p className="text-[0.6875rem] text-muted-foreground">
              {t.basedOnMonths(history.monthsUsed)} · {t.totalOutflow} {money(totalOutflow)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
