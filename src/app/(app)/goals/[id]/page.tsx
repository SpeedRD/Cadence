import { ChevronLeft, Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ContributionDialog } from "@/components/goals/contribution-dialog";
import {
  ContributionDeleteButton,
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
import { formatMoney } from "@/lib/currency";
import { getAppContext } from "@/lib/data/context";
import { getGoalDetail } from "@/lib/data/goals";
import { planPeriodRef } from "@/lib/data/payday";
import { formatDate, toISODate } from "@/lib/date";
import { getDictionary } from "@/lib/i18n";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Goal - Cadence" };

export default async function GoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await getAppContext();
  const detail = await getGoalDetail(id, context);
  if (!detail) notFound();
  const planRef = planPeriodRef(context);
  const confirmedCheckin = await prisma.paydayCheckin.findFirst({
    where: { year: planRef.year, month: planRef.month, period: planRef.period, status: "CONFIRMED" },
    include: { allocations: { where: { type: "GOAL", goalId: id } } },
  });
  const plannedAllocation = confirmedCheckin?.allocations[0] ?? null;

  const { summary, contributions, contributionTotal } = detail;
  const today = toISODate(context.today);
  const drifted = Math.abs(contributionTotal - summary.savedAmount) > 0.005;
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
              <span className="figure text-3xl">
                {formatMoney(summary.savedAmount, summary.currency)}
              </span>
              <span className="text-sm text-muted-foreground tnum">
                {t.percentOf(
                  Math.round(summary.progress * 100),
                  formatMoney(summary.targetAmount, summary.currency),
                )}
              </span>
            </div>
            <Meter value={summary.progress} max={1} status="accent" size="lg" />
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            <Stat
              label={t.stillToGo}
              value={formatMoney(summary.remaining, summary.currency)}
              hint={t.contributionCount(summary.contributionCount)}
            />
            {summary.perPeriod !== null ? (
              <Stat
                label={t.perPayPeriodLabel}
                value={formatMoney(summary.perPeriod, summary.currency)}
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
                  summary.pacePerPeriod
                    ? formatMoney(summary.pacePerPeriod, summary.currency)
                    : "-"
                }
                hint={
                  summary.projectedEnd
                    ? t.doneAround(formatDate(summary.projectedEnd))
                    : t.logToSetPace
                }
              />
            )}
            <Stat
              label={t.inCurrency(context.displayCurrency)}
              value={formatMoney(summary.displaySaved, context.displayCurrency)}
              hint={t.ofAmount(formatMoney(summary.displayTarget, context.displayCurrency))}
            />
          </div>

          {drifted ? (
            <p className="text-xs text-[var(--warning)]">
              {t.driftedWarning(formatMoney(contributionTotal, summary.currency))}
            </p>
          ) : null}

          {plannedAllocation ? (
            <p className="text-xs text-muted-foreground">
              {t.plannedThisPeriod(formatMoney(num(plannedAllocation.plannedAmount), summary.currency))}
              {num(plannedAllocation.recommendedAmount) - num(plannedAllocation.plannedAmount) > 0.005
                ? ` · ${t.plannedBehindRoadmap(
                    formatMoney(
                      num(plannedAllocation.recommendedAmount) - num(plannedAllocation.plannedAmount),
                      summary.currency,
                    ),
                  )}`
                : ""}
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
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {contributions.map((contribution) => (
                  <TableRow key={contribution.id}>
                    <TableCell className="figure text-xs text-muted-foreground">
                      {toISODate(contribution.date)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {contribution.note ?? "-"}
                    </TableCell>
                    <TableCell className="figure text-right text-sm">
                      {formatMoney(contribution.amount, contribution.currency)}
                    </TableCell>
                    <TableCell>
                      <ContributionDeleteButton
                        locale={context.language}
                        id={contribution.id}
                        amount={formatMoney(
                          contribution.amount,
                          contribution.currency,
                        )}
                      />
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
