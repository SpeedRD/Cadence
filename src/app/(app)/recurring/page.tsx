import { PiggyBank, Plus, Repeat } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { RecurringDialog } from "@/components/recurring/recurring-dialog";
import { RecurringList } from "@/components/recurring/recurring-list";
import { EmptyState } from "@/components/stat";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { getAppContext } from "@/lib/data/context";
import { listRecurringItems } from "@/lib/data/recurring";
import { toISODate } from "@/lib/date";
import { getDictionary } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Recurring - Cadence" };

export default async function RecurringPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).recurring;
  const common = getDictionary(context.language).common;
  const [data, categories, accounts, goals] = await Promise.all([
    listRecurringItems(context),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
    prisma.account.findMany({
      where: { status: "ACTIVE" },
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
    prisma.goal.findMany({
      orderBy: [{ achievedAt: "asc" }, { name: "asc" }],
      select: { id: true, name: true, currency: true },
    }),
  ]);

  const today = toISODate(context.today);
  const currency = context.displayCurrency;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <RecurringDialog
            categories={categories}
            accounts={accounts}
            goals={goals}
            values={{ nextDate: today, currency }}
            locale={context.language}
            trigger={
              <Button size="sm">
                <Plus className="size-3.5" />
                {t.newItem}
              </Button>
            }
          />
        }
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Repeat className="size-4 text-muted-foreground" />
              {t.subscriptions}
            </CardTitle>
            <CardDescription>
              {t.monthlyAcrossActive(
                formatMoney(data.subscriptionsMonthly, currency),
                data.subscriptions.filter((row) => row.active).length,
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.subscriptions.length === 0 ? (
              <EmptyState
                title={t.noSubscriptionsTitle}
                description={t.noSubscriptionsDescription}
              />
            ) : (
              <RecurringList
                rows={data.subscriptions}
                categories={categories}
                accounts={accounts}
                goals={goals}
                displayCurrency={currency}
                today={context.today}
                locale={context.language}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PiggyBank className="size-4 text-primary" />
              {t.recurringContributions}
            </CardTitle>
            <CardDescription>
              {t.monthlyGoingInto(formatMoney(data.contributionsMonthly, currency))}
            </CardDescription>
            <CardAction>
              <RecurringDialog
                categories={categories}
                accounts={accounts}
                goals={goals}
                values={{ nextDate: today, currency, kind: "CONTRIBUTION" }}
                locale={context.language}
                trigger={
                  <Button variant="ghost" size="xs">
                    <Plus className="size-3" />
                    {common.add}
                  </Button>
                }
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            {data.contributions.length === 0 ? (
              <EmptyState
                title={t.noContributionsTitle}
                description={t.noContributionsDescription}
              />
            ) : (
              <RecurringList
                rows={data.contributions}
                categories={categories}
                accounts={accounts}
                goals={goals}
                displayCurrency={currency}
                today={context.today}
                locale={context.language}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
