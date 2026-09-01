import { PageHeader } from "@/components/page-header";
import { CategoryBars } from "@/components/reports/category-bars";
import { MonthlyTrendChart } from "@/components/reports/monthly-trend-chart";
import { TrendChart } from "@/components/reports/trend-chart";
import { EmptyState, Stat } from "@/components/stat";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { getAppContext } from "@/lib/data/context";
import { getHistoricalMonthlyAverage } from "@/lib/data/monthly";
import { getPeriodSummary } from "@/lib/data/period-summary";
import { getSpendingTrend } from "@/lib/data/reports";
import { getDictionary } from "@/lib/i18n";

export const metadata = { title: "Reports - Cadence" };

const TREND_PERIODS = 6;

export default async function ReportsPage() {
  const context = await getAppContext();
  const dictionary = getDictionary(context.language);
  const t = dictionary.reports;
  const [summary, trend, monthlyHistory] = await Promise.all([
    getPeriodSummary(context.currentPeriod, context),
    getSpendingTrend(context, TREND_PERIODS),
    getHistoricalMonthlyAverage(context),
  ]);

  const spendingLines = summary.categories.filter((line) => line.spent > 0);
  const trendTotal = trend.reduce((total, point) => total + point.spent, 0);
  const average = trend.length > 0 ? trendTotal / trend.length : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={t.description(context.displayCurrency)}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.spendingByCategory}</CardTitle>
            <CardDescription>{summary.period.longLabel}</CardDescription>
          </CardHeader>
          <CardContent>
            {spendingLines.length === 0 ? (
              <EmptyState
                title={t.nothingSpentTitle}
                description={t.nothingSpentDescription}
              />
            ) : (
              <CategoryBars
                lines={spendingLines}
                currency={summary.currency}
                uncategorizedLabel={dictionary.common.uncategorized}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.lastNPeriods(TREND_PERIODS)}</CardTitle>
            <CardDescription>
              {t.averagePerPeriod(formatMoney(average, context.displayCurrency))}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TrendChart
              points={trend}
              currency={context.displayCurrency}
              currentKey={context.currentPeriod.key}
              t={t}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          <Stat
            label={t.thisPeriod}
            value={formatMoney(summary.spent, summary.currency)}
            hint={t.categoriesTouched(spendingLines.length)}
          />
          <Stat
            label={t.acrossNPeriods(TREND_PERIODS)}
            value={formatMoney(trendTotal, context.displayCurrency)}
          />
          <Stat
            label={t.incomeThisPeriod}
            value={formatMoney(summary.income, summary.currency)}
          />
        </CardContent>
      </Card>

      <div className="space-y-1 pt-2">
        <h2 className="text-base font-semibold">{t.monthlySectionTitle}</h2>
        <p className="text-sm text-muted-foreground">{t.monthlySectionDescription}</p>
      </div>

      {!monthlyHistory.sufficient ? (
        <Card>
          <CardContent>
            <EmptyState
              title={t.monthlyInsufficientTitle}
              description={t.monthlyInsufficientDescription(monthlyHistory.monthsUsed)}
            />
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t.monthlyCategoryBreakdown}</CardTitle>
                <CardDescription>{t.monthlyNormalSpendingNote}</CardDescription>
              </CardHeader>
              <CardContent>
                {monthlyHistory.averageLifestyleByCategory.length === 0 ? (
                  <EmptyState
                    title={t.nothingSpentTitle}
                    description={t.nothingSpentDescription}
                  />
                ) : (
                  <CategoryBars
                    lines={monthlyHistory.averageLifestyleByCategory}
                    currency={context.displayCurrency}
                    uncategorizedLabel={dictionary.common.uncategorized}
                  />
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t.monthlyTrendTitle(monthlyHistory.monthsUsed)}</CardTitle>
                <CardDescription>
                  {t.monthlyAverageSummary(
                    formatMoney(monthlyHistory.averageNormalSpending, context.displayCurrency),
                    monthlyHistory.monthsUsed,
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MonthlyTrendChart
                  months={monthlyHistory.months}
                  currency={context.displayCurrency}
                  t={t}
                />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="grid gap-6 sm:grid-cols-3">
              <Stat
                label={t.monthlyCommittedAverage}
                value={formatMoney(monthlyHistory.averageCommitted, context.displayCurrency)}
                hint={t.monthlyCommittedHint}
              />
              <Stat
                label={t.monthlySavingsAverage}
                value={formatMoney(monthlyHistory.averageSavingsInvesting, context.displayCurrency)}
                hint={t.monthlySavingsHint}
              />
              <Stat
                label={t.monthlyTotalOutflowAverage}
                value={formatMoney(monthlyHistory.averageTotalOutflow, context.displayCurrency)}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
