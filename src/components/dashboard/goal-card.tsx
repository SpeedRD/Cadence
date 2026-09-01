import Link from "next/link";

import { Meter } from "@/components/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { formatDate } from "@/lib/date";
import type { Dictionary } from "@/lib/i18n";

import type { GoalSummary } from "@/lib/data/goals";

export function GoalCard({
  goal,
  displayCurrency,
  t,
}: {
  goal: GoalSummary;
  displayCurrency: string;
  t: Dictionary["dashboard"];
}) {
  const showConverted = goal.currency !== displayCurrency;

  return (
    <Card size="sm" className="transition-colors hover:bg-accent/40">
      <CardHeader>
        <CardTitle>
          <Link href={`/goals/${goal.id}`} className="hover:underline">
            {goal.name}
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className="figure text-lg">
              {formatMoney(goal.savedAmount, goal.currency)}
            </span>
            <span className="text-xs text-muted-foreground tnum">
              {Math.round(goal.progress * 100)}%
            </span>
          </div>
          <Meter value={goal.progress} max={1} status="accent" />
          <p className="text-xs text-muted-foreground">
            {t.of(formatMoney(goal.targetAmount, goal.currency))}
            {showConverted
              ? ` · ${formatMoney(goal.displaySaved, displayCurrency)} of ${formatMoney(goal.displayTarget, displayCurrency)}`
              : ""}
          </p>
        </div>

        {goal.achievedAt ? (
          <p className="text-xs text-[var(--good)]">{t.reached}</p>
        ) : goal.targetDate && goal.perPeriod !== null ? (
          <p className="text-xs text-muted-foreground">
            <span className="text-foreground figure">
              {formatMoney(goal.perPeriod, goal.currency)}
            </span>{" "}
            {t.perPayPeriod} ·{" "}
            {goal.periodsLeft === 0
              ? t.dueThisPeriod
              : t.periodsTo(goal.periodsLeft!, formatDate(goal.targetDate))}
          </p>
        ) : goal.pacePerPeriod ? (
          <p className="text-xs text-muted-foreground">
            {t.pace}{" "}
            <span className="text-foreground figure">
              {formatMoney(goal.pacePerPeriod, goal.currency)}
            </span>{" "}
            {t.perPeriod}
            {goal.projectedEnd ? ` · ${t.onTrackFor(formatDate(goal.projectedEnd))}` : ""}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t.noContributionsYet}</p>
        )}
      </CardContent>
    </Card>
  );
}
