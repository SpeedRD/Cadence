import Link from "next/link";

import { GoalCard } from "@/components/dashboard/goal-card";
import { MonthlyPaceCard } from "@/components/dashboard/monthly-pace-card";
import { NotPostingAlert } from "@/components/dashboard/not-posting-alert";
import { PaydayCheckinCard } from "@/components/dashboard/payday-checkin-card";
import { PeriodHero } from "@/components/dashboard/period-hero";
import { UpcomingList } from "@/components/dashboard/upcoming-list";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSettings } from "@/lib/auth";
import { isSameDay } from "@/lib/date";
import { getAppContext } from "@/lib/data/context";
import { getDashboardData, UPCOMING_WINDOW_DAYS } from "@/lib/data/dashboard";
import { getMonthlyPace } from "@/lib/data/monthly";
import { getPaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary } from "@/lib/i18n";
import { summarizePaydayDraft } from "@/lib/payday";
import { daysElapsedInPeriod, isAfterPaydayInPeriod, periodKey } from "@/lib/period";

export const metadata = { title: "Dashboard - Cadence" };

export default async function DashboardPage() {
  const context = await getAppContext();
  const dictionary = getDictionary(context.language);
  const t = dictionary.dashboard;
  const [{ summary, upcoming, goals }, monthlyPace, paydayDraft, settings] = await Promise.all([
    getDashboardData(context),
    getMonthlyPace(context),
    getPaydayCheckinDraft(context),
    getSettings(),
  ]);
  const elapsed = daysElapsedInPeriod(context.today, context.currentPeriod);
  const activeGoals = goals.filter((goal) => !goal.achievedAt);
  const shownGoals = activeGoals.length > 0 ? activeGoals : goals;
  const dismissedToday = settings.checkinPromptDismissedOn
    ? isSameDay(settings.checkinPromptDismissedOn, context.today)
    : false;
  // Same window as planPeriodRef: from the day the pay lands (pulled back off a
  // weekend) until the period ends, so a Friday-shifted payday still prompts on
  // the weekend that follows it rather than only on the Friday itself.
  const shouldAutoOpenCheckin =
    isAfterPaydayInPeriod(context.today) &&
    !paydayDraft.isEditingConfirmed &&
    !dismissedToday;
  // Only once the *current* period's check-in is confirmed and no overall
  // budget exists yet: the draft plans the next period on a payday date, and a
  // suggestion for a different period than the hero shows would mislead.
  const suggestedBudget =
    paydayDraft.isEditingConfirmed &&
    periodKey(paydayDraft.periodRef) === summary.period.key &&
    summary.overallBudget === null
      ? summarizePaydayDraft(paydayDraft, context.rates).available
      : null;

  return (
    <div className="space-y-6">
      {context.recurringPosting ? (
        <NotPostingAlert posting={context.recurringPosting} t={t} />
      ) : null}
      <PaydayCheckinCard
        draft={paydayDraft}
        rates={context.rates}
        locale={context.language}
        shouldAutoOpen={shouldAutoOpenCheckin}
      />
      <PeriodHero summary={summary} elapsed={elapsed} suggestedBudget={suggestedBudget} t={t} />

      <MonthlyPaceCard
        data={monthlyPace}
        displayCurrency={context.displayCurrency}
        t={dictionary.monthlyPace}
      />

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
