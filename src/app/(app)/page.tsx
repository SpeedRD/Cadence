import Link from "next/link";

import { GoalCard } from "@/components/dashboard/goal-card";
import { PeriodHero } from "@/components/dashboard/period-hero";
import { UpcomingList } from "@/components/dashboard/upcoming-list";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAppContext } from "@/lib/data/context";
import { getDashboardData, UPCOMING_WINDOW_DAYS } from "@/lib/data/dashboard";
import { getDictionary } from "@/lib/i18n";
import { daysElapsedInPeriod } from "@/lib/period";

export const metadata = { title: "Dashboard - Cadence" };

export default async function DashboardPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).dashboard;
  const { summary, upcoming, goals } = await getDashboardData(context);
  const elapsed = daysElapsedInPeriod(context.today, context.currentPeriod);
  const activeGoals = goals.filter((goal) => !goal.achievedAt);
  const shownGoals = activeGoals.length > 0 ? activeGoals : goals;

  return (
    <div className="space-y-6">
      <PeriodHero summary={summary} elapsed={elapsed} t={t} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">{t.goalsHeading}</h2>
            <Button asChild variant="ghost" size="xs">
              <Link href="/goals">{t.allGoals}</Link>
            </Button>
          </div>
          {shownGoals.length === 0 ? (
            <EmptyState
              title={t.noGoalsTitle}
              description={t.noGoalsDescription}
              action={
                <Button asChild size="sm">
                  <Link href="/goals">{t.createGoal}</Link>
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {shownGoals.map((goal) => (
                <GoalCard
                  key={goal.id}
                  goal={goal}
                  displayCurrency={context.displayCurrency}
                  t={t}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <Card size="sm">
            <CardHeader>
              <CardTitle>{t.nextDays(UPCOMING_WINDOW_DAYS)}</CardTitle>
            </CardHeader>
            <CardContent>
              {upcoming.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  {t.nothingDue}
                </p>
              ) : (
                <UpcomingList
                  items={upcoming}
                  today={context.today}
                  displayCurrency={context.displayCurrency}
                  t={t}
                  common={getDictionary(context.language).common}
                />
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
