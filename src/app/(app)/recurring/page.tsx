import { Calculator, PiggyBank, Plus, Repeat, Sparkles } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { RecurringDialog } from "@/components/recurring/recurring-dialog";
import { RecurringList } from "@/components/recurring/recurring-list";
import { RecurringSuggestions } from "@/components/recurring/recurring-suggestions";
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
import {
  FROM_AFFORD_SECTION_ID,
  summarizeAffordViability,
  type AffordViability,
} from "@/lib/afford-tracking";
import { formatMoney } from "@/lib/currency";
import { getAffordRechecks } from "@/lib/data/afford";
import { getAppContext } from "@/lib/data/context";
import { listRecurringItems } from "@/lib/data/recurring";
import { findRecurringSuggestions } from "@/lib/data/recurring-suggestions";
import { toISODate } from "@/lib/date";
import { getDictionary } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Recurring - Cadence" };

export default async function RecurringPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).recurring;
  const common = getDictionary(context.language).common;
  const [data, rechecks, suggestions, categories, accounts, goals] = await Promise.all([
    listRecurringItems(context),
    getAffordRechecks(),
    findRecurringSuggestions(context),
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
  // One verdict per tracked plan, reduced to the badge each row shows. A
  // From Afford row with no entry - paused, finished, or its account gone -
  // simply shows none.
  const viability: Record<string, AffordViability> = Object.fromEntries(
    rechecks.map((tracked) => [tracked.itemId, summarizeAffordViability(tracked.verdict)]),
  );
  const activeFromAfford = data.fromAfford.filter((row) => row.active).length;

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
              <Button size="sm" className="max-sm:hidden">
                <Plus className="size-3.5" />
                {t.newItem}
              </Button>
            }
          />
        }
        titleAction={
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

      {/* Patterns in the organic ledger that look like an untracked bill
          (src/lib/recurring-detection.ts), scanned on every load of this
          page. Only here when there is something to review: each row is
          added or dismissed by hand, and the section goes away on its own
          once nothing is left. */}
      {suggestions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-primary" />
              {t.suggestionsTitle}
            </CardTitle>
            <CardDescription>{t.suggestionsDescription(suggestions.length)}</CardDescription>
          </CardHeader>
          <CardContent>
            <RecurringSuggestions
              suggestions={suggestions}
              displayCurrency={currency}
              locale={context.language}
            />
          </CardContent>
        </Card>
      ) : null}

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

      {/* Plans recorded by Afford's "I bought this". Their own section, not
          a subscription with a tag: each one still paying is re-checked here
          against today's projections (see recheckAffordItems). The id is
          the Dashboard alert's link target. */}
      <Card id={FROM_AFFORD_SECTION_ID} className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Calculator className="size-4 text-muted-foreground" />
            {t.fromAfford}
          </CardTitle>
          <CardDescription>
            {t.fromAffordDescription(formatMoney(data.fromAffordMonthly, currency), activeFromAfford)}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.fromAfford.length === 0 ? (
            <EmptyState
              title={t.noFromAffordTitle}
              description={t.noFromAffordDescription}
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href="/afford">{t.openAfford}</Link>
                </Button>
              }
            />
          ) : (
            <RecurringList
              rows={data.fromAfford}
              categories={categories}
              accounts={accounts}
              goals={goals}
              displayCurrency={currency}
              today={context.today}
              locale={context.language}
              viability={viability}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
