import { ArrowRightLeft, Plus, Upload } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { TransactionFilters } from "@/components/transactions/transaction-filters";
import { TransactionTable } from "@/components/transactions/transaction-table";
import { TransferDialog } from "@/components/transactions/transfer-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatMoney } from "@/lib/currency";
import { getAppContext } from "@/lib/data/context";
import { getDictionary } from "@/lib/i18n";
import {
  listTransactions,
  summarizeTransactions,
  PAGE_SIZE,
  type TransactionFilters as Filters,
} from "@/lib/data/transactions";
import { fromISODate, toISODate } from "@/lib/date";
import { prisma } from "@/lib/prisma";

export const metadata = { title: "Transactions - Cadence" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function single(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value || undefined;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const context = await getAppContext();
  const t = getDictionary(context.language).transactions;
  const common = getDictionary(context.language).common;

  const filters: Filters = {
    accountId: single(params.account),
    categoryId: single(params.category),
    type: single(params.type),
    source: single(params.source),
    from: fromISODate(single(params.from) ?? "") ?? undefined,
    to: fromISODate(single(params.to) ?? "") ?? undefined,
    query: single(params.q),
    page: Number(single(params.page) ?? 1) || 1,
  };

  const [accounts, categories, result, totals] = await Promise.all([
    prisma.account.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, currency: true },
    }),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
    listTransactions(filters, context),
    summarizeTransactions(filters, context),
  ]);

  const buildPageHref = (page: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      const flat = single(value);
      if (flat && key !== "page") next.set(key, flat);
    }
    if (page > 1) next.set("page", String(page));
    const search = next.toString();
    return search ? `/transactions?${search}` : "/transactions";
  };

  const today = toISODate(context.today);
  const hasAccounts = accounts.length > 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={t.recordsSummary(result.total, formatMoney(totals.expense, context.displayCurrency), formatMoney(totals.income, context.displayCurrency))}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/transactions/import">
                <Upload className="size-3.5" />
                {t.importCsv}
              </Link>
            </Button>
            {accounts.length > 1 ? (
              <TransferDialog
                accounts={accounts}
                values={{ date: today, currency: context.displayCurrency }}
                locale={context.language}
                trigger={
                  <Button variant="outline" size="sm">
                    <ArrowRightLeft className="size-3.5" />
                    {t.transfer}
                  </Button>
                }
              />
            ) : null}
            {hasAccounts ? (
              <TransactionDialog
                accounts={accounts}
                categories={categories}
                values={{ date: today, currency: context.displayCurrency }}
                locale={context.language}
                trigger={
                  <Button size="sm">
                    <Plus className="size-3.5" />
                    {t.new}
                  </Button>
                }
              />
            ) : null}
          </>
        }
      />

      <TransactionFilters
        accounts={accounts}
        categories={categories}
        locale={context.language}
        values={{
          account: single(params.account),
          category: single(params.category),
          type: single(params.type),
          source: single(params.source),
          from: single(params.from),
          to: single(params.to),
          q: single(params.q),
        }}
      />

      {!hasAccounts ? (
        <EmptyState
          title={t.addAccountFirstTitle}
          description={t.needAccountDescription}
          action={
            <Button asChild size="sm">
              <Link href="/accounts">{t.goToAccounts}</Link>
            </Button>
          }
        />
      ) : result.rows.length === 0 ? (
        <EmptyState
          title={t.nothingHereTitle}
          description={t.noMatchFilters}
        />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <TransactionTable
              rows={result.rows}
              accounts={accounts}
              categories={categories}
              displayCurrency={context.displayCurrency}
              locale={context.language}
            />
          </CardContent>
        </Card>
      )}

      {result.pageCount > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <p className="text-muted-foreground tnum">
            {t.pageOf(result.page, result.pageCount, PAGE_SIZE)}
          </p>
          <div className="flex gap-2">
            <Button
              asChild={result.page > 1}
              variant="outline"
              size="sm"
              disabled={result.page <= 1}
            >
              {result.page > 1 ? (
                <Link href={buildPageHref(result.page - 1)}>{t.previous}</Link>
              ) : (
                <span>{t.previous}</span>
              )}
            </Button>
            <Button
              asChild={result.page < result.pageCount}
              variant="outline"
              size="sm"
              disabled={result.page >= result.pageCount}
            >
              {result.page < result.pageCount ? (
                <Link href={buildPageHref(result.page + 1)}>{t.next}</Link>
              ) : (
                <span>{t.next}</span>
              )}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
