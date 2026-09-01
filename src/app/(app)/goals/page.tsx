import { Plus } from "lucide-react";
import Link from "next/link";

import { ContributionDialog } from "@/components/goals/contribution-dialog";
import { GoalActions } from "@/components/goals/goal-actions";
import { GoalDialog } from "@/components/goals/goal-dialog";
import { Meter } from "@/components/meter";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { getAppContext } from "@/lib/data/context";
import { listGoals } from "@/lib/data/goals";
import { formatDate, toISODate } from "@/lib/date";
import { getDictionary } from "@/lib/i18n";

export const metadata = { title: "Goals - Cadence" };

export default async function GoalsPage() {
  const context = await getAppContext();
  const goals = await listGoals(context);
  const today = toISODate(context.today);
  const t = getDictionary(context.language).goals;
  const common = getDictionary(context.language).common;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <GoalDialog
            values={{ currency: context.displayCurrency }}
            locale={context.language}
            trigger={
              <Button size="sm">
                <Plus className="size-3.5" />
                {t.newGoal}
              </Button>
            }
          />
        }
      />

      {goals.length === 0 ? (
        <EmptyState
          title={t.noGoalsTitle}
          description={t.noGoalsDescription}
          action={
            <GoalDialog
              values={{ currency: context.displayCurrency }}
              locale={context.language}
              trigger={<Button size="sm">{t.createFirstGoal}</Button>}
            />
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {goals.map((goal) => (
            <Card key={goal.id}>
              <CardContent className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/goals/${goal.id}`}
                      className="text-base font-medium hover:underline"
                    >
                      {goal.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {goal.achievedAt
                        ? t.reached
                        : goal.targetDate
                          ? t.targetDate(formatDate(goal.targetDate))
                          : t.noTargetDate}
                    </p>
                  </div>
                  <GoalActions
                    locale={context.language}
                    goal={{
                      id: goal.id,
                      name: goal.name,
                      targetAmount: goal.targetAmount,
                      currency: goal.currency,
                      targetDate: goal.targetDate
                        ? toISODate(goal.targetDate)
                        : null,
                    }}
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="figure text-xl">
                      {formatMoney(goal.savedAmount, goal.currency)}
                    </span>
                    <span className="text-xs text-muted-foreground tnum">
                      {t.percentOf(
                        Math.round(goal.progress * 100),
                        formatMoney(goal.targetAmount, goal.currency),
                      )}
                    </span>
                  </div>
                  <Meter value={goal.progress} max={1} status="accent" size="lg" />
                </div>

                <div className="flex items-end justify-between gap-3">
                  <div className="text-xs text-muted-foreground">
                    {goal.achievedAt ? (
                      <span className="text-[var(--good)]">{t.fullyFunded}</span>
                    ) : goal.perPeriod !== null ? (
                      <>
                        <span className="figure text-foreground">
                          {formatMoney(goal.perPeriod, goal.currency)}
                        </span>{" "}
                        {t.perPayPeriod}
                        {goal.periodsLeft !== null
                          ? goal.periodsLeft === 0
                            ? ` · ${t.dueThisPeriod}`
                            : ` · ${t.periodsLeft(goal.periodsLeft)}`
                          : ""}
                      </>
                    ) : goal.pacePerPeriod ? (
                      <>
                        {t.pace}{" "}
                        <span className="figure text-foreground">
                          {formatMoney(goal.pacePerPeriod, goal.currency)}
                        </span>{" "}
                        {t.perPeriod}
                        {goal.projectedEnd
                          ? ` · ${t.onTrackApprox(formatDate(goal.projectedEnd))}`
                          : ""}
                      </>
                    ) : (
                      t.toGo(formatMoney(goal.remaining, goal.currency))
                    )}
                  </div>
                  <ContributionDialog
                    goalId={goal.id}
                    goalName={goal.name}
                    currency={goal.currency}
                    defaultDate={today}
                    locale={context.language}
                    trigger={
                      <Button variant="outline" size="xs">
                        {common.add}
                      </Button>
                    }
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
