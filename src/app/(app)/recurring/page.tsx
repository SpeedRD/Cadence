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
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Recurring - Cadence" };

export default async function RecurringPage() {
  const context = await getAppContext();
  const [data, categories] = await Promise.all([
    listRecurringItems(context),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  const today = toISODate(context.today);
  const currency = context.displayCurrency;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Recurring"
        description="Everything that leaves on a schedule. Both kinds reduce safe to spend for the period they fall in."
        actions={
          <RecurringDialog
            categories={categories}
            values={{ nextDate: today, currency }}
            trigger={
              <Button size="sm">
                <Plus className="size-3.5" />
                New item
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
              Subscriptions
            </CardTitle>
            <CardDescription>
              {formatMoney(data.subscriptionsMonthly, currency)} a month across{" "}
              {data.subscriptions.filter((row) => row.active).length} active item
              {data.subscriptions.filter((row) => row.active).length === 1
                ? ""
                : "s"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.subscriptions.length === 0 ? (
              <EmptyState
                title="No subscriptions"
                description="Add the bills that repeat so they stop surprising you mid-period."
              />
            ) : (
              <RecurringList
                rows={data.subscriptions}
                categories={categories}
                displayCurrency={currency}
                today={context.today}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PiggyBank className="size-4 text-primary" />
              Recurring contributions
            </CardTitle>
            <CardDescription>
              {formatMoney(data.contributionsMonthly, currency)} a month going
              into something
            </CardDescription>
            <CardAction>
              <RecurringDialog
                categories={categories}
                values={{ nextDate: today, currency, kind: "CONTRIBUTION" }}
                trigger={
                  <Button variant="ghost" size="xs">
                    <Plus className="size-3" />
                    Add
                  </Button>
                }
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            {data.contributions.length === 0 ? (
              <EmptyState
                title="No recurring contributions"
                description="Money you put in on a schedule - an investment, a savings sweep - lives here."
              />
            ) : (
              <RecurringList
                rows={data.contributions}
                categories={categories}
                displayCurrency={currency}
                today={context.today}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
