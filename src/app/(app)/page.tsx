import Link from "next/link";

import { GoalCard } from "@/components/dashboard/goal-card";
import { PeriodHero } from "@/components/dashboard/period-hero";
import { UpcomingList } from "@/components/dashboard/upcoming-list";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getAppContext } from "@/lib/data/context";
import { getDashboardData, UPCOMING_WINDOW_DAYS } from "@/lib/data/dashboard";
import { daysElapsedInPeriod } from "@/lib/period";

export const metadata = { title: "Dashboard - Cadence" };

export default async function DashboardPage() {
  const context = await getAppContext();
  const { summary, upcoming, goals } = await getDashboardData(context);
  const elapsed = daysElapsedInPeriod(context.today, context.currentPeriod);
  const activeGoals = goals.filter((goal) => !goal.achievedAt);
  const shownGoals = activeGoals.length > 0 ? activeGoals : goals;

  return (
    <div className="space-y-6">
      <PeriodHero summary={summary} elapsed={elapsed} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <section className="space-y-3">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-base font-semibold">Goals</h2>
            <Button asChild variant="ghost" size="xs">
              <Link href="/goals">All goals</Link>
            </Button>
          </div>
          {shownGoals.length === 0 ? (
            <EmptyState
              title="No goals yet"
              description="Track something you are saving towards and Cadence works out what each pay period needs to carry."
              action={
                <Button asChild size="sm">
                  <Link href="/goals">Create a goal</Link>
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
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <Card size="sm">
            <CardHeader>
              <CardTitle>Next {UPCOMING_WINDOW_DAYS} days</CardTitle>
            </CardHeader>
            <CardContent>
              {upcoming.length === 0 ? (
                <p className="py-2 text-sm text-muted-foreground">
                  Nothing due in the next week.
                </p>
              ) : (
                <UpcomingList
                  items={upcoming}
                  today={context.today}
                  displayCurrency={context.displayCurrency}
                />
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
