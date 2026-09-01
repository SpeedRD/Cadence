import Link from "next/link";

import { Meter } from "@/components/meter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { formatDate } from "@/lib/date";

import type { GoalSummary } from "@/lib/data/goals";

export function GoalCard({
  goal,
  displayCurrency,
}: {
  goal: GoalSummary;
  displayCurrency: string;
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
            of {formatMoney(goal.targetAmount, goal.currency)}
            {showConverted
              ? ` · ${formatMoney(goal.displaySaved, displayCurrency)} of ${formatMoney(goal.displayTarget, displayCurrency)}`
              : ""}
          </p>
        </div>

        {goal.achievedAt ? (
          <p className="text-xs text-[var(--good)]">Reached</p>
        ) : goal.targetDate && goal.perPeriod !== null ? (
          <p className="text-xs text-muted-foreground">
            <span className="text-foreground figure">
              {formatMoney(goal.perPeriod, goal.currency)}
            </span>{" "}
            per pay period ·{" "}
            {goal.periodsLeft === 0
              ? "due this period"
              : `${goal.periodsLeft} periods to ${formatDate(goal.targetDate)}`}
          </p>
        ) : goal.pacePerPeriod ? (
          <p className="text-xs text-muted-foreground">
            Pace{" "}
            <span className="text-foreground figure">
              {formatMoney(goal.pacePerPeriod, goal.currency)}
            </span>{" "}
            per period
            {goal.projectedEnd ? ` · on track for ${formatDate(goal.projectedEnd)}` : ""}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">No contributions yet</p>
        )}
      </CardContent>
    </Card>
  );
}
