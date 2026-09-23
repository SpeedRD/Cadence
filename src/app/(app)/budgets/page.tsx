import { ChevronLeft, ChevronRight, Copy } from "lucide-react";
import Link from "next/link";

import { BudgetAmountForm } from "@/components/budgets/budget-amount-form";
import { ActionButton } from "@/components/form/action-button";
import { Meter, meterStatus } from "@/components/meter";
import { PageHeader } from "@/components/page-header";
import { PlanThisPeriodButton } from "@/components/payday/plan-this-period-button";
import { Stat } from "@/components/stat";
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
import { round2 } from "@/lib/money";
import { getAppContext } from "@/lib/data/context";
import { getPaydayCheckinDraft, planPeriodRef } from "@/lib/data/payday";
import { getPeriodSummary } from "@/lib/data/period-summary";
import { getDictionary } from "@/lib/i18n";
import {
  nextPeriod,
  parsePeriodKey,
  periodInfo,
  periodKey,
  previousPeriod,
} from "@/lib/period";
import { prisma } from "@/lib/prisma";
import { copyPreviousBudgetsAction } from "@/server/actions/budgets";

export const metadata = { title: "Budgets - Cadence" };

/** How much of a category's budget is spent, as a whole percentage. */
function usedPercent(spent: number, budget: number) {
  return Math.round((spent / Math.max(budget, 0.01)) * 100);
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getAppContext();
  const t = getDictionary(context.language).budgets;

  const requested = parsePeriodKey(
    typeof params.period === "string" ? params.period : undefined,
  );
  const period = periodInfo(requested ?? context.currentPeriod);
  const isCurrent = period.key === context.currentPeriod.key;
  const isPlanTarget = period.key === periodKey(planPeriodRef(context));

  // The Dashboard hero links here with ?suggested=<amount> (its recommended
  // overall budget from the confirmed payday check-in). It only ever pre-fills
  // the field - the user still has to save - and is ignored once an overall
  // budget exists or when it isn't a positive amount the form would accept.
  const suggestedParam = typeof params.suggested === "string" ? Number(params.suggested) : NaN;
  const suggestedBudget =
    Number.isFinite(suggestedParam) && suggestedParam > 0 ? round2(suggestedParam) : null;

  const [summary, categories, paydayDraft] = await Promise.all([
    getPeriodSummary(period, context),
    prisma.category.findMany({
      where: { kind: "EXPENSE" },
      orderBy: { name: "asc" },
    }),
    // The wizard for whichever period is being viewed - the one the dashboard
    // prompt plans for, a past one never checked in, or one to revisit.
    getPaydayCheckinDraft(context, { year: period.year, month: period.month, period: period.period }),
  ]);
  const paydayLabels = getDictionary(context.language).payday;
  const planButtonLabel = paydayDraft.isEditingConfirmed
    ? paydayLabels.reviewConfirmedPlan
    : isPlanTarget
      ? paydayLabels.planThisPeriod
      : paydayLabels.checkInForPeriod;

  // Every budget figure on this page - the inputs included - comes from the
  // period summary, which has already converted each stored budget into the
  // display currency exactly once. Reading prisma.budget here instead would
  // put stored DOP amounts next to converted USD spending, and the progress
  // meters would compare the two.
  const budgetByCategory = new Map(
    summary.categories
      .filter((line) => line.categoryId !== null)
      .map((line) => [line.categoryId as string, line.budget]),
  );
  const spentByCategory = new Map(
    summary.categories.map((line) => [line.categoryId ?? "none", line.spent]),
  );

  const rows = categories
    .map((category) => ({
      category,
      budget: budgetByCategory.get(category.id) ?? null,
      spent: spentByCategory.get(category.id) ?? 0,
    }))
    .sort((a, b) => {
      // A budget of exactly 0 still counts as "has a budget", as before.
      const aHas = a.budget !== null ? 1 : 0;
      const bHas = b.budget !== null ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (b.spent !== a.spent) return b.spent - a.spent;
      return a.category.name.localeCompare(b.category.name);
    });

  const uncategorized = summary.categories.find((line) => line.categoryId === null);
  const prefilledOverall = summary.overallBudget === null ? suggestedBudget : null;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <>
            <PlanThisPeriodButton
              draft={paydayDraft}
              rates={context.rates}
              locale={context.language}
              label={planButtonLabel}
              className="max-sm:hidden"
            />
            {/* On a phone the same action, filled as the page's primary.
                Its labels ("Check in for this period", "Hacer el check-in
                de este periodo") are too long to trail the title, so it leads
                this row instead. */}
            <PlanThisPeriodButton
              draft={paydayDraft}
              rates={context.rates}
              locale={context.language}
              label={planButtonLabel}
              variant="default"
              className="sm:hidden"
            />
            <ActionButton
              action={copyPreviousBudgetsAction}
              fields={{
                year: period.year,
                month: period.month,
                period: period.period,
              }}
              size="sm"
            >
              <Copy className="size-3.5" />
              {t.copyLastPeriod}
            </ActionButton>
          </>
        }
      />

      <div className="hidden flex-wrap items-center gap-2 sm:flex">
        <Button asChild variant="outline" size="sm">
          <Link href={`/budgets?period=${periodKey(previousPeriod(period))}`}>
            <ChevronLeft className="size-3.5" />
            {periodInfo(previousPeriod(period)).label}
          </Link>
        </Button>
        <span className="px-1 text-sm font-medium">{period.longLabel}</span>
        <Button asChild variant="outline" size="sm">
          <Link href={`/budgets?period=${periodKey(nextPeriod(period))}`}>
            {periodInfo(nextPeriod(period)).label}
            <ChevronRight className="size-3.5" />
          </Link>
        </Button>
        {!isCurrent ? (
          <Button asChild variant="ghost" size="sm">
            <Link href="/budgets">{t.backToNow}</Link>
          </Button>
        ) : null}
      </div>

      {/* On a phone the labelled buttons don't fit beside the long label, so
          the stepper becomes chevrons at opposite ends of the period they
          change; the neighbouring period's name moves to the aria-label and
          tooltip. */}
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 sm:hidden">
        <Button asChild variant="outline" size="icon-lg">
          <Link
            href={`/budgets?period=${periodKey(previousPeriod(period))}`}
            aria-label={periodInfo(previousPeriod(period)).longLabel}
            title={periodInfo(previousPeriod(period)).longLabel}
          >
            <ChevronLeft />
          </Link>
        </Button>
        <div className="flex flex-col items-center text-center">
          <span className="text-sm font-medium">{period.longLabel}</span>
          {!isCurrent ? (
            <Button asChild variant="ghost" size="sm">
              <Link href="/budgets">{t.backToNow}</Link>
            </Button>
          ) : null}
        </div>
        <Button asChild variant="outline" size="icon-lg">
          <Link
            href={`/budgets?period=${periodKey(nextPeriod(period))}`}
            aria-label={periodInfo(nextPeriod(period)).longLabel}
            title={periodInfo(nextPeriod(period)).longLabel}
          >
            <ChevronRight />
          </Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.overallBudget}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <BudgetAmountForm
              year={period.year}
              month={period.month}
              period={period.period}
              categoryId={null}
              amount={summary.overallBudget ?? prefilledOverall}
              currency={summary.currency}
              label={t.overallBudgetForPeriod}
              locale={context.language}
              size="lg"
            />
            <p className="text-xs text-muted-foreground">
              {prefilledOverall !== null
                ? t.prefilledFromCheckin(formatMoney(prefilledOverall, summary.currency))
                : summary.overallBudget === null
                  ? t.noOverallSet(formatMoney(summary.categoryBudgetTotal, summary.currency))
                  : t.clearToRemove}
            </p>
            <div className="space-y-2">
              <Meter
                value={summary.spent}
                max={summary.periodBudget}
                size="lg"
                status={
                  summary.periodBudget > 0
                    ? meterStatus(summary.spent, summary.periodBudget)
                    : "neutral"
                }
              />
              <p className="text-xs text-muted-foreground">
                {t.spentOf(
                  formatMoney(summary.spent, summary.currency),
                  formatMoney(summary.periodBudget, summary.currency),
                )}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 border-t border-border/70 pt-4 lg:grid-cols-1 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <Stat
              label={t.committed}
              value={formatMoney(summary.committed, summary.currency)}
              hint={t.recurringStillToCome(summary.committedItems.length)}
            />
            <Stat
              label={t.safeToSpend}
              value={formatMoney(summary.safeToSpend, summary.currency)}
              hint={
                isCurrent
                  ? t.perDay(
                      formatMoney(summary.safeToSpendPerDay, summary.currency),
                      summary.daysRemaining,
                    )
                  : t.forWholePeriod
              }
              valueClassName={
                summary.safeToSpend < 0 ? "text-[var(--critical)]" : undefined
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardContent className="px-0">
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.colCategory}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t.colProgress}</TableHead>
                  <TableHead className="text-right">{t.colSpent}</TableHead>
                  <TableHead className="text-right">{t.colBudget}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ category, budget: budgetDisplay, spent }) => {
                  return (
                    <TableRow key={category.id}>
                      <TableCell>
                        <span className="flex items-center gap-2 text-sm">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: category.color }}
                          />
                          {category.name}
                        </span>
                      </TableCell>
                      <TableCell className="hidden w-56 sm:table-cell">
                        {budgetDisplay ? (
                          <div className="space-y-1">
                            <Meter value={spent} max={budgetDisplay} />
                            <p className="text-hint text-muted-foreground tnum">
                              {usedPercent(spent, budgetDisplay)}%
                            </p>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t.noBudget}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="figure text-right text-sm">
                        {formatMoney(spent, summary.currency)}
                      </TableCell>
                      <TableCell>
                        <BudgetAmountForm
                          year={period.year}
                          month={period.month}
                          period={period.period}
                          categoryId={category.id}
                          amount={budgetDisplay}
                          currency={summary.currency}
                          label={t.categoryBudgetAria(category.name)}
                          locale={context.language}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {uncategorized ? (
                  <TableRow>
                    <TableCell className="text-sm text-muted-foreground">
                      {t.uncategorized}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell" />
                    <TableCell className="figure text-right text-sm">
                      {formatMoney(uncategorized.spent, summary.currency)}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>

          {/* The phone list (below `sm`): category and spent on line 1,
              the meter the table hides on a phone on line 2, and the budget
              field at full width on line 3. */}
          <div className="sm:hidden">
            <div className="flex h-10 items-center justify-between gap-3 border-b px-4 font-medium">
              <span>{t.colCategory}</span>
              <span>{t.colSpent}</span>
            </div>
            <ul className="divide-y">
              {rows.map(({ category, budget: budgetDisplay, spent }) => (
                <li key={category.id} className="space-y-2.5 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2 text-sm">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      <span className="break-words">{category.name}</span>
                    </span>
                    <span className="figure text-sm">{formatMoney(spent, summary.currency)}</span>
                  </div>
                  {budgetDisplay ? (
                    <div className="flex items-center gap-3">
                      <Meter value={spent} max={budgetDisplay} />
                      <span className="shrink-0 text-hint text-muted-foreground tnum">
                        {usedPercent(spent, budgetDisplay)}%
                      </span>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t.noBudget}</p>
                  )}
                  <div className="flex items-center gap-3">
                    <span className="shrink-0 text-xs text-muted-foreground">{t.colBudget}</span>
                    <BudgetAmountForm
                      year={period.year}
                      month={period.month}
                      period={period.period}
                      categoryId={category.id}
                      amount={budgetDisplay}
                      currency={summary.currency}
                      label={t.categoryBudgetAria(category.name)}
                      locale={context.language}
                      size="block"
                    />
                  </div>
                </li>
              ))}
              {uncategorized ? (
                <li className="flex items-start justify-between gap-3 px-4 py-3">
                  <span className="text-sm text-muted-foreground">{t.uncategorized}</span>
                  <span className="figure text-sm">
                    {formatMoney(uncategorized.spent, summary.currency)}
                  </span>
                </li>
              ) : null}
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
