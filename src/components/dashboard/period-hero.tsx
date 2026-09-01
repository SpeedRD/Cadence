import Link from "next/link";

import { Meter, meterStatus } from "@/components/meter";
import { Money } from "@/components/money";
import { PeriodRail } from "@/components/period-rail";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { formatDayMonth } from "@/lib/date";

import type { PeriodSummary } from "@/lib/data/period-summary";

export function PeriodHero({
  summary,
  elapsed,
}: {
  summary: PeriodSummary;
  elapsed: number;
}) {
  const { period, currency } = summary;
  const used = summary.periodBudget > 0 ? summary.spent / summary.periodBudget : 0;

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="grid gap-8 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-6">
          <div className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="eyebrow">
                Period {period.period} · {period.longLabel}
              </p>
              <p className="text-xs text-muted-foreground">
                {summary.daysRemaining === 0
                  ? "closed"
                  : `${summary.daysRemaining} of ${period.totalDays} days left`}
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
              <p className="eyebrow">Safe to spend per day</p>
              <p className="figure text-5xl leading-none font-medium">
                {formatMoney(summary.safeToSpendPerDay, currency)}
              </p>
              <p className="text-sm text-muted-foreground">
                {summary.safeToSpend >= 0 ? (
                  <>
                    <Money amount={summary.safeToSpend} currency={currency} /> left
                    for the rest of this period
                  </>
                ) : (
                  <>
                    <Money
                      amount={Math.abs(summary.safeToSpend)}
                      currency={currency}
                      className="text-[var(--critical)]"
                    />{" "}
                    over the plan for this period
                  </>
                )}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="eyebrow">Safe to spend per day</p>
              <p className="text-sm text-muted-foreground">
                Set a budget for this period and Cadence works out what you can
                spend each day after committed outflows.
              </p>
              <Button asChild size="sm">
                <Link href="/budgets">Set this period&rsquo;s budget</Link>
              </Button>
            </div>
          )}
        </div>

        <div className="grid gap-5 border-t border-border/70 pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="eyebrow">Spent</p>
              <p className="text-xs text-muted-foreground tnum">
                {summary.periodBudget > 0
                  ? `${Math.round(used * 100)}% of budget`
                  : "no budget"}
              </p>
            </div>
            <p className="figure text-2xl">
              {formatMoney(summary.spent, currency)}
            </p>
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
              of {formatMoney(summary.periodBudget, currency)} budgeted
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-1">
            <div className="space-y-1">
              <dt className="eyebrow">Committed</dt>
              <dd className="figure text-base">
                {formatMoney(summary.committed, currency)}
              </dd>
              <p className="text-[0.6875rem] text-muted-foreground">
                {summary.committedItems.length} item
                {summary.committedItems.length === 1 ? "" : "s"} due before{" "}
                {formatDayMonth(period.end)}
              </p>
            </div>
            <div className="space-y-1">
              <dt className="eyebrow">Income</dt>
              <dd className="figure text-base">
                {formatMoney(summary.income, currency)}
              </dd>
              <p className="text-[0.6875rem] text-muted-foreground">
                logged this period
              </p>
            </div>
          </dl>
        </div>
      </div>
    </Card>
  );
}
