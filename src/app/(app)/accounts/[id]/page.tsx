import { ChevronLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AccountDialog } from "@/components/accounts/account-dialog";
import { PageHeader } from "@/components/page-header";
import { SourceBadge } from "@/components/source-badge";
import { EmptyState, Stat } from "@/components/stat";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { getAccountLedger } from "@/lib/data/accounts";
import { getAppContext } from "@/lib/data/context";
import { toISODate } from "@/lib/date";
import { getDictionary } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const metadata = { title: "Account - Cadence" };

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await getAppContext();
  const t = getDictionary(context.language).accounts;
  const common = getDictionary(context.language).common;
  const ledger = await getAccountLedger(id, context);
  if (!ledger) notFound();

  const { account, rows, totals } = ledger;

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="xs" className="-ml-2">
        <Link href="/accounts">
          <ChevronLeft className="size-3.5" />
          {t.accountsBreadcrumb}
        </Link>
      </Button>

      <PageHeader
        title={account.name}
        description={`${labelFor(common.accountTypeLabels, account.type)} · ${account.currency}`}
        actions={
          <AccountDialog
            values={{
              id: account.id,
              name: account.name,
              type: account.type,
              currency: account.currency,
            }}
            locale={context.language}
            trigger={
              <Button variant="outline" size="sm">
                <Pencil className="size-3.5" />
                {common.edit}
              </Button>
            }
          />
        }
      />

      <Card>
        <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label={t.balance}
            value={formatMoney(ledger.balance, account.currency)}
            hint={
              account.currency !== context.displayCurrency
                ? formatMoney(ledger.displayBalance, context.displayCurrency)
                : t.transactionCount(rows.length)
            }
          />
          <Stat
            label={t.incomeIn}
            value={formatMoney(totals.inflow, account.currency)}
          />
          <Stat
            label={t.spendingOut}
            value={formatMoney(totals.outflow, account.currency)}
          />
          <Stat
            label={t.netTransfers}
            value={formatMoney(
              totals.transfersIn - totals.transfersOut,
              account.currency,
              { signDisplay: "always" },
            )}
            hint={t.inOut(
              formatMoney(totals.transfersIn, account.currency),
              formatMoney(totals.transfersOut, account.currency),
            )}
          />
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title={t.noActivityTitle}
          description={t.noActivityDescription}
          action={
            <Button asChild size="sm">
              <Link href="/transactions">{t.addTransaction}</Link>
            </Button>
          }
        />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[104px]">{common.date}</TableHead>
                    <TableHead>{common.description}</TableHead>
                    <TableHead className="hidden md:table-cell">{common.source}</TableHead>
                    <TableHead className="text-right">{t.colChange}</TableHead>
                    <TableHead className="text-right">{t.balance}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="figure text-xs text-muted-foreground">
                        {toISODate(row.date)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="truncate text-sm">
                            {row.note ??
                              (row.type === "TRANSFER"
                                ? row.transferDirection === "OUT"
                                  ? t.transferTo(row.counterpartAccountName ?? t.anotherAccount)
                                  : t.transferFrom(row.counterpartAccountName ?? t.anotherAccount)
                                : (row.categoryName ?? common.uncategorized))}
                          </span>
                          {row.categoryName ? (
                            <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                              <span
                                className="size-1.5 rounded-full"
                                style={{
                                  backgroundColor:
                                    row.categoryColor ?? "var(--muted-foreground)",
                                }}
                              />
                              {row.categoryName}
                            </span>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <SourceBadge
                          source={row.source}
                          isTransfer={row.type === "TRANSFER"}
                          labels={common.sourceLabels}
                          transferLabel={t.transfer}
                        />
                      </TableCell>
                      <TableCell className="text-right">
                        <span
                          className={cn(
                            "figure text-sm",
                            row.effect > 0 && row.type === "INCOME" && "text-[var(--good)]",
                            row.type === "TRANSFER" && "text-muted-foreground",
                          )}
                        >
                          {row.effect > 0 ? "+" : "-"}
                          {formatMoney(Math.abs(row.effect), account.currency)}
                        </span>
                      </TableCell>
                      <TableCell className="figure text-right text-sm text-muted-foreground">
                        {formatMoney(row.runningBalance, account.currency)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
