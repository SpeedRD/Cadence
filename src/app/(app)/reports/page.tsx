import { PageHeader } from "@/components/page-header";
import { CategoryBars } from "@/components/reports/category-bars";
import { TrendChart } from "@/components/reports/trend-chart";
import { EmptyState, Stat } from "@/components/stat";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { getAppContext } from "@/lib/data/context";
import { getPeriodSummary } from "@/lib/data/period-summary";
import { getSpendingTrend } from "@/lib/data/reports";

export const metadata = { title: "Reports - Cadence" };

const TREND_PERIODS = 6;

export default async function ReportsPage() {
  const context = await getAppContext();
  const [summary, trend] = await Promise.all([
    getPeriodSummary(context.currentPeriod, context),
    getSpendingTrend(context, TREND_PERIODS),
  ]);

  const spendingLines = summary.categories.filter((line) => line.spent > 0);
  const trendTotal = trend.reduce((total, point) => total + point.spent, 0);
  const average = trend.length > 0 ? trendTotal / trend.length : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports"
        description={`Everything in ${context.displayCurrency}, converted at current rates.`}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Spending by category</CardTitle>
            <CardDescription>{summary.period.longLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            {spendingLines.length === 0 ? (
              <EmptyState
                title="Nothing spent this period"
                description="Categorised spending shows up here as soon as you log it."
              />
            ) : (
              <CategoryBars lines={spendingLines} currency={summary.currency} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Last {TREND_PERIODS} pay periods</CardTitle>
            <CardDescription>
              {formatMoney(average, context.displayCurrency)} average per period
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart
              points={trend}
              currency={context.displayCurrency}
              currentKey={context.currentPeriod.key}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          <Stat
            label="This period"
            value={formatMoney(summary.spent, summary.currency)}
            hint={`${spendingLines.length} categor${spendingLines.length === 1 ? "y" : "ies"} touched`}
          />
          <Stat
            label={`Across ${TREND_PERIODS} periods`}
            value={formatMoney(trendTotal, context.displayCurrency)}
          />
          <Stat
            label="Income this period"
            value={formatMoney(summary.income, summary.currency)}
          />
        </CardContent>
      </Card>
    </div>
  );
}
