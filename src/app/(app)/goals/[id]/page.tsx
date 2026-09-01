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
import { formatDate, toISODate } from "@/lib/date";

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

  const { summary, contributions, contributionTotal } = detail;
  const today = toISODate(context.today);
  const drifted = Math.abs(contributionTotal - summary.savedAmount) > 0.005;

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="xs" className="-ml-2">
        <Link href="/goals">
          <ChevronLeft className="size-3.5" />
          Goals
        </Link>
      </Button>

      <PageHeader
        title={summary.name}
        description={
          summary.targetDate
            ? `Target ${formatDate(summary.targetDate)}`
            : "No target date - pace is projected from your contributions"
        }
        actions={
          <>
            <ContributionDialog
              goalId={summary.id}
              goalName={summary.name}
              currency={summary.currency}
              defaultDate={today}
              trigger={
                <Button size="sm">
                  <Plus className="size-3.5" />
                  Log contribution
                </Button>
              }
            />
            <GoalActions
              redirectAfterDelete
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
                {Math.round(summary.progress * 100)}% of{" "}
                {formatMoney(summary.targetAmount, summary.currency)}
              </span>
            </div>
            <Meter value={summary.progress} max={1} status="accent" size="lg" />
          </div>

          <div className="grid gap-6 sm:grid-cols-3">
            <Stat
              label="Still to go"
              value={formatMoney(summary.remaining, summary.currency)}
              hint={`${summary.contributionCount} contribution${summary.contributionCount === 1 ? "" : "s"}`}
            />
            {summary.perPeriod !== null ? (
              <Stat
                label="Per pay period"
                value={formatMoney(summary.perPeriod, summary.currency)}
                hint={
                  summary.periodsLeft === 0
                    ? "due this period"
                    : `${summary.periodsLeft} periods to the target date`
                }
              />
            ) : (
              <Stat
                label="Pace"
                value={
                  summary.pacePerPeriod
                    ? formatMoney(summary.pacePerPeriod, summary.currency)
                    : "-"
                }
                hint={
                  summary.projectedEnd
                    ? `on this pace, done around ${formatDate(summary.projectedEnd)}`
                    : "log a contribution to set a pace"
                }
              />
            )}
            <Stat
              label={`In ${context.displayCurrency}`}
              value={formatMoney(summary.displaySaved, context.displayCurrency)}
              hint={`of ${formatMoney(summary.displayTarget, context.displayCurrency)}`}
            />
          </div>

          {drifted ? (
            <p className="text-xs text-[var(--warning)]">
              Cached progress does not match the contribution history
              ({formatMoney(contributionTotal, summary.currency)}). Recalculate
              from Settings.
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle>Contribution history</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-2">
          {contributions.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState
                title="No contributions yet"
                description="Every amount you log here is the source of truth for this goal's progress."
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[104px]">Date</TableHead>
                  <TableHead>Note</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
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
