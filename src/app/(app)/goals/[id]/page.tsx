import { ChevronLeft, Plus } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ContributionDialog } from "@/components/goals/contribution-dialog";
import {
  ContributionDeleteButton,
  ContributionEditButton,
  GoalActions,
  ManualContributionEditButton,
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
import { getGoalRoadmapStatuses } from "@/lib/data/payday";
import { toISODate } from "@/lib/date";
import { formatDate, formatPeriodShort } from "@/lib/date-format";
import { getDictionary } from "@/lib/i18n";
import { round2 } from "@/lib/money";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Goal - Cadence" };

export default async function GoalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await getAppContext();
  const [detail, accounts, accountsForEdit] = await Promise.all([
    getGoalDetail(id, context),
    prisma.account.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
    // Every account regardless of status, so editing a contribution logged
    // against one since archived still shows it selected - see
    // ManualContributionEditButton and the transactions page's own
    // accountsForEdit.
    prisma.account.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
  ]);
  if (!detail) notFound();
  // The goal's plan for the plan period (K3): its pace fixed at the period's
  // start, what the check-in funds by hand, what the confirmed check-in
  // planned and what has gone in, with the two statements read off it - the
  // planning shortfall (and what the room could not cover at confirm) and the
  // follow-through shortfall once the period's last days come. The Inbox's
  // goal detector reads the same statuses, so the two never disagree. An
  // earlier period's plan that was not carried out is noted too.
  const statuses = (await getGoalRoadmapStatuses(context)).filter((status) => status.goalId === id);
  const roadmapStatus = statuses.find((status) => status.role === "plan") ?? null;
  const earlierStatuses = statuses.filter((status) => status.role === "earlier");

  const { summary, contributions, contributionTotal, displayContributionTotal } = detail;
  const today = toISODate(context.today);
  // The cached total holds every contribution; savedAmount leaves out the ones dated after today.
  const drifted = Math.abs(contributionTotal - (summary.savedAmount + summary.savedAhead)) > 0.005;
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
            ? t.targetDate(formatDate(summary.targetDate, context.language))
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
              rates={context.rates.rates}
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
                isDebt: summary.isDebt,
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
            {summary.savedAhead > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t.savedAhead(formatMoney(summary.displaySavedAhead, display))}
              </p>
            ) : null}
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            <Stat
              label={t.stillToGo}
              value={formatMoney(summary.displayRemaining, display)}
              hint={t.contributionCount(summary.contributionCount)}
            />
            {summary.displayPerPeriod !== null ? (
              <Stat
                label={summary.plan.scheduled > 0 ? t.perPayPeriodByHandLabel : t.perPayPeriodLabel}
                value={formatMoney(summary.displayPerPeriod, display)}
                hint={[
                  ...(summary.plan.scheduled > 0 ? [t.fromRecurring(formatMoney(summary.plan.scheduled, display))] : []),
                  summary.periodsLeft === 0 ? t.dueThisPeriod : t.periodsToTarget(summary.periodsLeft ?? 0),
                ].join(" · ")}
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
                    ? t.doneAround(formatDate(summary.projectedEnd, context.language))
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

          {summary.plan.planned !== null ? (
            <p className="text-xs text-muted-foreground">
              {t.planVersusContributed(
                formatPeriodShort(summary.plan.period, context.language),
                formatMoney(summary.plan.planned, display),
                formatMoney(summary.plan.contributed, display),
              )}
              {roadmapStatus && roadmapStatus.planningShortfall > 0
                ? ` · ${t.plannedBehindRoadmap(formatMoney(roadmapStatus.planningShortfall, display))}`
                : ""}
              {!summary.targetDate && summary.plan.open && summary.plan.byHand - summary.plan.planned > 0.005
                ? ` · ${t.plannedBehindRemaining(formatMoney(round2(summary.plan.byHand - summary.plan.planned), display))}`
                : ""}
            </p>
          ) : summary.plan.contributed > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t.contributedInPeriod(formatPeriodShort(summary.plan.period, context.language), formatMoney(summary.plan.contributed, display))}
            </p>
          ) : null}
          {roadmapStatus && roadmapStatus.roomShortfall > 0 ? (
            <p className="text-xs text-[var(--warning)]">
              {t.roomShortfallThisPeriod(formatMoney(roadmapStatus.roomShortfall, display), formatPeriodShort(roadmapStatus.period, context.language))}
            </p>
          ) : null}
          {!summary.targetDate && summary.plan.open && summary.plan.recommended !== null && summary.plan.byHand - summary.plan.recommended > 0.005 ? (
            <p className="text-xs text-[var(--warning)]">
              {t.roomShortfallRemainingThisPeriod(
                formatMoney(round2(summary.plan.byHand - summary.plan.recommended), display),
                formatPeriodShort(summary.plan.period, context.language),
              )}
            </p>
          ) : null}
          {[...(roadmapStatus && roadmapStatus.followThroughShortfall > 0 ? [roadmapStatus] : []), ...earlierStatuses].map((status) => (
            <p key={status.period.key} className="text-xs text-[var(--warning)]">
              {t.notYetContributed(formatMoney(status.followThroughShortfall, display), formatPeriodShort(status.period, context.language))}
            </p>
          ))}
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
                        ) : contribution.accountId ? (
                          <ManualContributionEditButton
                            locale={context.language}
                            id={contribution.id}
                            amount={contribution.amount}
                            currency={contribution.currency}
                            date={toISODate(contribution.date)}
                            accountId={contribution.accountId}
                            accounts={accountsForEdit}
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
