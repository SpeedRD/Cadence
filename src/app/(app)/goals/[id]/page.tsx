import { ChevronLeft, Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ContributionDialog } from "@/components/goals/contribution-dialog";
import {
  ContributionDeleteButton,
  ContributionEditButton,
  GoalActions,
} from "@/components/goals/goal-actions";
import { Meter } from "@/components/meter";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Stat } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { convert, formatMoney } from "@/lib/currency";
import { getAppContext } from "@/lib/data/context";
import { getGoalDetail } from "@/lib/data/goals";
import { getGoalRoadmapAmount, planPeriodRef } from "@/lib/data/payday";
import { formatDate, toISODate } from "@/lib/date";
import { getDictionary } from "@/lib/i18n";
import { num, round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Goal - Cadence" };

export default async function GoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await getAppContext();
  const [detail, accounts] = await Promise.all([
    getGoalDetail(id, context),
    prisma.account.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
  ]);
  if (!detail) notFound();
  const planRef = planPeriodRef(context);
  const [confirmedCheckin, roadmapAmount] = await Promise.all([
    prisma.paydayCheckin.findFirst({
      where: { year: planRef.year, month: planRef.month, period: planRef.period, status: "CONFIRMED" },
      include: { allocations: { where: { type: "GOAL", goalId: id } } },
    }),
    // The real pace for the plan period, computed live. The rows' own
    // recommendedAmount is each account's share of that pace capped by the
    // account's room, so summing them says what the accounts could fund - not
    // what the target needs. "Behind the roadmap" is measured against the pace.
    getGoalRoadmapAmount(id, planRef, context),
  ]);
  // One GOAL row per account the goal draws on, each in that account's
  // currency - or, from a check-in confirmed before funding was per-account,
  // a single accountless row in the check-in's currency. The goal's planned
  // figure is the rows summed into the display currency; `recommendedAmount`
  // summed the same way is what the accounts' room let the plan schedule.
  const plannedAllocation =
    confirmedCheckin && confirmedCheckin.allocations.length > 0
      ? confirmedCheckin.allocations.reduce(
          (sum, allocation) => ({
            plannedAmount: round2(
              sum.plannedAmount +
                convert(num(allocation.plannedAmount), allocation.currency, context.displayCurrency, context.rates),
            ),
            recommendedAmount: round2(
              sum.recommendedAmount +
                convert(num(allocation.recommendedAmount), allocation.currency, context.displayCurrency, context.rates),
            ),
          }),
          { plannedAmount: 0, recommendedAmount: 0 },
        )
      : null;

  const { summary, contributions, contributionTotal, displayContributionTotal } = detail;
  const today = toISODate(context.today);
  const drifted = Math.abs(contributionTotal - summary.savedAmount) > 0.005;
  const display = context.displayCurrency;
  const t = getDictionary(context.language).goals;
  const common = getDictionary(context.language).common;

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="xs" className="-ml-2">
        <Link href="/goals">
          <ChevronLeft className="size-3.5" />
          {t.goalsBreadcrumb}
        </Link>
      </Button>

      <PageHeader
        title={summary.name}
        description={
          summary.targetDate
            ? t.targetDate(formatDate(summary.targetDate))
            : t.noTargetPaceNote
        }
        actions={
          <>
            <ContributionDialog
              goalId={summary.id}
              goalName={summary.name}
              currency={summary.currency}
              accounts={accounts}
              defaultDate={today}
              locale={context.language}
              trigger={
                <Button size="sm">
                  <Plus className="size-3.5" />
                  {t.logContribution}
                </Button>
              }
            />
            <GoalActions
              redirectAfterDelete
              locale={context.language}
              goal={{
                id: summary.id,
                name: summary.name,
                targetAmount: summary.targetAmount,
                currency: summary.currency,
                targetDate: summary.targetDate
                  ? toISODate(summary.targetDate)
                  : null,
              }}
            />
          </>
        }
      />

      <Card>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="figure figure-lg text-3xl">
                {formatMoney(summary.displaySaved, display)}
              </span>
              <span className="text-sm text-muted-foreground tnum">
                {t.percentOf(
                  Math.round(summary.progress * 100),
                  formatMoney(summary.displayTarget, display),
                )}
              </span>
            </div>
            <Meter value={summary.progress} max={1} status="accent" size="lg" />
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            <Stat
              label={t.stillToGo}
              value={formatMoney(summary.displayRemaining, display)}
              hint={t.contributionCount(summary.contributionCount)}
            />
            {summary.displayPerPeriod !== null ? (
              <Stat
                label={t.perPayPeriodLabel}
                value={formatMoney(summary.displayPerPeriod, display)}
                hint={
                  summary.periodsLeft === 0
                    ? t.dueThisPeriod
                    : t.periodsToTarget(summary.periodsLeft ?? 0)
                }
              />
            ) : (
              <Stat
                label={t.pace}
                value={
                  summary.displayPacePerPeriod
                    ? formatMoney(summary.displayPacePerPeriod, display)
                    : "-"
                }
                hint={
                  summary.projectedEnd
                    ? t.doneAround(formatDate(summary.projectedEnd))
                    : t.logToSetPace
                }
              />
            )}
            {/* The figures above follow the display currency; this is the
                goal's own stored denomination, which never changes with it. */}
            <Stat
              label={t.inCurrency(summary.currency)}
              value={formatMoney(summary.savedAmount, summary.currency)}
              hint={t.ofAmount(formatMoney(summary.targetAmount, summary.currency))}
            />
          </div>

          {drifted ? (
            <p className="text-xs text-[var(--warning)]">
              {t.driftedWarning(formatMoney(displayContributionTotal, display))}
            </p>
          ) : null}

          {plannedAllocation ? (
            <p className="text-xs text-muted-foreground">
              {t.plannedThisPeriod(formatMoney(plannedAllocation.plannedAmount, display))}
              {roadmapAmount !== null && roadmapAmount - plannedAllocation.plannedAmount > 0.005
                ? ` · ${t.plannedBehindRoadmap(
                    formatMoney(round2(roadmapAmount - plannedAllocation.plannedAmount), display),
                  )}`
                : ""}
            </p>
          ) : null}
          {plannedAllocation && roadmapAmount !== null && roadmapAmount - plannedAllocation.recommendedAmount > 0.005 ? (
            <p className="text-xs text-[var(--warning)]">
              {t.roomShortfallThisPeriod(
                formatMoney(round2(roadmapAmount - plannedAllocation.recommendedAmount), display),
              )}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>{t.contributionHistory}</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {contributions.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                title={t.noContributionsYetTitle}
                description={t.noContributionsYetDescription}
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[104px]">{common.date}</TableHead>
                  <TableHead>{common.note}</TableHead>
                  <TableHead className="text-right">{common.amount}</TableHead>
                  <TableHead className="w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contributions.map((contribution) => (
                  <TableRow key={contribution.id}>
                    <TableCell className="figure figure-sm text-xs text-muted-foreground">
                      {toISODate(contribution.date)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {contribution.note ?? "-"}
                    </TableCell>
                    <TableCell className="figure text-right text-sm">
                      {formatMoney(contribution.amount, contribution.currency)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        {contribution.recurringExternalId ? (
                          <ContributionEditButton
                            locale={context.language}
                            id={contribution.id}
                            amount={contribution.amount}
                            currency={contribution.currency}
                          />
                        ) : null}
                        <ContributionDeleteButton
                          locale={context.language}
                          id={contribution.id}
                          amount={formatMoney(
                            contribution.amount,
                            contribution.currency,
                          )}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
