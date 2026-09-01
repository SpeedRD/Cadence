import { ChevronLeft, ChevronRight, Copy } from "lucide-react";
import Link from "next/link";

import { BudgetAmountForm } from "@/components/budgets/budget-amount-form";
import { ActionButton } from "@/components/form/action-button";
import { Meter, meterStatus } from "@/components/meter";
import { PageHeader } from "@/components/page-header";
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
import { getAppContext } from "@/lib/data/context";
import { getPeriodSummary } from "@/lib/data/period-summary";
import { num } from "@/lib/money";
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

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function BudgetsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getAppContext();

  const requested = parsePeriodKey(
    typeof params.period === "string" ? params.period : undefined,
  );
  const period = periodInfo(requested ?? context.currentPeriod);
  const isCurrent = period.key === context.currentPeriod.key;

  const [summary, categories, budgetRows] = await Promise.all([
    getPeriodSummary(period, context),
    prisma.category.findMany({
      where: { kind: "EXPENSE" },
      orderBy: { name: "asc" },
    }),
    prisma.budget.findMany({
      where: { year: period.year, month: period.month, period: period.period },
    }),
  ]);

  const budgetByCategory = new Map(
    budgetRows
      .filter((budget) => budget.categoryId)
      .map((budget) => [budget.categoryId as string, budget]),
  );
  const overallRow = budgetRows.find((budget) => budget.categoryId === null);
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
      const aHas = a.budget ? 1 : 0;
      const bHas = b.budget ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (b.spent !== a.spent) return b.spent - a.spent;
      return a.category.name.localeCompare(b.category.name);
    });

  const uncategorized = summary.categories.find((line) => line.categoryId === null);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Budgets"
        description="Set per pay period. The overall budget drives safe to spend; category budgets track where it goes."
        actions={
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
            Copy last period
          </ActionButton>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
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
            <Link href="/budgets">Back to now</Link>
          </Button>
        ) : null}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overall budget</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4">
            <BudgetAmountForm
              year={period.year}
              month={period.month}
              period={period.period}
              categoryId={null}
              amount={overallRow ? num(overallRow.amount) : null}
              currency={overallRow?.currency ?? context.displayCurrency}
              label="Overall budget for this period"
              size="lg"
            />
            <p className="text-xs text-muted-foreground">
              {summary.overallBudget === null
                ? `No overall budget set. Category budgets total ${formatMoney(summary.categoryBudgetTotal, summary.currency)} and are used instead.`
                : "Clear the field to remove the overall budget."}
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
                {formatMoney(summary.spent, summary.currency)} spent of{" "}
                {formatMoney(summary.periodBudget, summary.currency)}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 border-t border-border/70 pt-4 lg:grid-cols-1 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <Stat
              label="Committed"
              value={formatMoney(summary.committed, summary.currency)}
              hint={`${summary.committedItems.length} recurring item${summary.committedItems.length === 1 ? "" : "s"} still to come`}
            />
            <Stat
              label="Safe to spend"
              value={formatMoney(summary.safeToSpend, summary.currency)}
              hint={
                isCurrent
                  ? `${formatMoney(summary.safeToSpendPerDay, summary.currency)} a day for ${summary.daysRemaining} day${summary.daysRemaining === 1 ? "" : "s"}`
                  : "for the whole period"
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Category</TableHead>
                <TableHead className="hidden sm:table-cell">Progress</TableHead>
                <TableHead className="text-right">Spent</TableHead>
                <TableHead className="text-right">Budget</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ category, budget, spent }) => {
                const budgetDisplay = budget ? num(budget.amount) : null;
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
                          <p className="text-[0.6875rem] text-muted-foreground tnum">
                            {Math.round((spent / Math.max(budgetDisplay, 0.01)) * 100)}%
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          no budget
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
                        currency={budget?.currency ?? context.displayCurrency}
                        label={`${category.name} budget`}
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
              {uncategorized ? (
                <TableRow>
                  <TableCell className="text-sm text-muted-foreground">
                    Uncategorized
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
        </CardContent>
      </Card>
    </div>
  );
}
