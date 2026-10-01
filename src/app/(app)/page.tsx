import Link from "next/link";

import { AffordViabilityAlert } from "@/components/dashboard/afford-viability-alert";
import { GoalCard } from "@/components/dashboard/goal-card";
import { MonthlyPaceCard } from "@/components/dashboard/monthly-pace-card";
import { NotPostingAlert } from "@/components/dashboard/not-posting-alert";
import { PaydayCheckinCard } from "@/components/dashboard/payday-checkin-card";
import { PeriodHero } from "@/components/dashboard/period-hero";
import { PostingRunFailedAlert } from "@/components/dashboard/posting-run-failed-alert";
import { UpcomingList } from "@/components/dashboard/upcoming-list";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSettings } from "@/lib/auth";
import { isSameDay } from "@/lib/date";
import { getAffordRechecks } from "@/lib/data/afford";
import { getAppContext } from "@/lib/data/context";
import { getDashboardData, UPCOMING_WINDOW_DAYS } from "@/lib/data/dashboard";
import { getInsights } from "@/lib/data/insights";
import { loadConfirmedRooms } from "@/lib/data/flexible-room";
import { recommendationFor } from "@/lib/flexible-room";
import { getMonthlyPace } from "@/lib/data/monthly";
import { getPaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary } from "@/lib/i18n";
import { daysElapsedInPeriod, isAfterPaydayInPeriod, periodInfo, periodKey } from "@/lib/period";

export const metadata = { title: "Dashboard - Cadence" };

export default async function DashboardPage() {
  const context = await getAppContext();
  const dictionary = getDictionary(context.language);
  const t = dictionary.dashboard;
  const [{ summary, upcoming, goals }, monthlyPace, paydayDraft, settings, affordRechecks, insights] =
    await Promise.all([
      getDashboardData(context),
      getMonthlyPace(context),
      getPaydayCheckinDraft(context),
      getSettings(),
      getAffordRechecks(),
      getInsights(),
    ]);
  // The posting_run_failed insight: the latest run threw. Not dismissible, so
  // it is always in the list while it is true and gone with the next good run.
  const postingRunFailed = insights.some((insight) => insight.source === "posting_run_failed");
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
  // K4 for the two periods this page speaks about: the one the hero shows
  // and the one the check-in card plans (the next one, from payday to period
  // end). A confirmed period reads what was confirmed, not a draft rebuilt
  // from today's settings and rates.
  const rooms = await loadConfirmedRooms([summary.period, periodInfo(paydayDraft.periodRef)], context);
  const cardRoom = paydayDraft.isEditingConfirmed ? (rooms.get(periodKey(paydayDraft.periodRef)) ?? null) : null;
  const heroRoom = rooms.get(summary.period.key) ?? null;
  // "Recommended" is the current period's own room, only once its check-in is
  // confirmed and no overall budget exists: shown while nothing is budgeted,
  // and while the budgets leave part of the room in no budget - money that
  // otherwise carries to the next period (D24). Budgets holding all of it
  // need no reminder.
  const recommended = recommendationFor(summary, heroRoom);

  // Ordered by what the card currently is, not by what component it is. Before
  // the check-in is confirmed it is a prompt carrying the page's primary action,
  // and it leads. Once confirmed it becomes a read-only receipt of a decision
  // already made (see PaydayCheckinCard's isEditingConfirmed branch) and would
  // otherwise hold first place for the rest of the period, pushing safe-to-spend
  // - the reason to open Cadence on an ordinary day - below the fold.
  const checkinCard = (
    <PaydayCheckinCard
      draft={paydayDraft}
      rates={context.rates}
      locale={context.language}
      shouldAutoOpen={shouldAutoOpenCheckin}
      room={
        cardRoom
          ? {
              income: cardRoom.income,
              buffer: cardRoom.buffer,
              available: cardRoom.available,
              flexibleBudgeted: cardRoom.flexibleBudgeted,
              essential: cardRoom.essential,
              unallocated: cardRoom.unallocated,
              cushion: cardRoom.cushion,
            }
          : null
      }
    />
  );
  const checkinLeads = !paydayDraft.isEditingConfirmed;

  // Rendered twice: beside Goals from sm up, and on a phone directly after the
  // hero, because there the daily question is what is about to leave the
  // account before how the goals are doing. A second copy rather than CSS
  // order, so VoiceOver and focus follow the order the phone shows.
  const upcomingCard = (
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
            locale={context.language}
            t={t}
            common={getDictionary(context.language).common}
          />
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-6">
      {postingRunFailed ? <PostingRunFailedAlert t={t} /> : null}
      {context.recurringPosting ? (
        <NotPostingAlert posting={context.recurringPosting} locale={context.language} t={t} />
      ) : null}
      <AffordViabilityAlert tracked={affordRechecks} locale={context.language} t={t} />
      {checkinLeads ? checkinCard : null}
      <PeriodHero summary={summary} elapsed={elapsed} recommended={recommended} locale={context.language} t={t} />
      <section className="sm:hidden">{upcomingCard}</section>
      {checkinLeads ? null : checkinCard}

      <MonthlyPaceCard
        data={monthlyPace}
        displayCurrency={context.displayCurrency}
        locale={context.language}
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
                  locale={context.language}
                  t={t}
                />
              ))}
            </div>
          )}
        </section>

        <section className="max-sm:hidden">{upcomingCard}</section>
      </div>
    </div>
  );
}
