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
import { ACCOUNT_TYPE_LABELS, labelFor } from "@/lib/labels";
import { cn } from "@/lib/utils";

export const metadata = { title: "Account - Cadence" };

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const context = await getAppContext();
  const ledger = await getAccountLedger(id, context);
  if (!ledger) notFound();

  const { account, rows, totals } = ledger;

  return (
    <div className="space-y-5">
      <Button asChild variant="ghost" size="xs" className="-ml-2">
        <Link href="/accounts">
          <ChevronLeft className="size-3.5" />
          Accounts
        </Link>
      </Button>

      <PageHeader
        title={account.name}
        description={`${labelFor(ACCOUNT_TYPE_LABELS, account.type)} · ${account.currency}`}
        actions={
          <AccountDialog
            values={{
              id: account.id,
              name: account.name,
              type: account.type,
              currency: account.currency,
            }}
            trigger={
              <Button variant="outline" size="sm">
                <Pencil className="size-3.5" />
                Edit
              </Button>
            }
          />
        }
      />

      <Card>
        <CardContent className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Balance"
            value={formatMoney(ledger.balance, account.currency)}
            hint={
              account.currency !== context.displayCurrency
                ? formatMoney(ledger.displayBalance, context.displayCurrency)
                : `${rows.length} transaction${rows.length === 1 ? "" : "s"}`
            }
          />
          <Stat
            label="Income in"
            value={formatMoney(totals.inflow, account.currency)}
          />
          <Stat
            label="Spending out"
            value={formatMoney(totals.outflow, account.currency)}
          />
          <Stat
            label="Net transfers"
            value={formatMoney(
              totals.transfersIn - totals.transfersOut,
              account.currency,
              { signDisplay: "always" },
            )}
            hint={`${formatMoney(totals.transfersIn, account.currency)} in · ${formatMoney(totals.transfersOut, account.currency)} out`}
          />
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="No activity yet"
          description="Transactions logged against this account show up here with a running balance."
          action={
            <Button asChild size="sm">
              <Link href="/transactions">Add a transaction</Link>
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
                    <TableHead className="w-[104px]">Date</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="hidden md:table-cell">Source</TableHead>
                    <TableHead className="text-right">Change</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
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
                                ? `Transfer ${row.transferDirection === "OUT" ? "to" : "from"} ${row.counterpartAccountName ?? "another account"}`
                                : (row.categoryName ?? "Uncategorized"))}
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
                          labels={{
                            MANUAL: "Manual",
                            CSV: "CSV",
                            GMAIL: "Gmail",
                            OUTLOOK: "Outlook",
                            PAYPAL: "PayPal",
                          }}
                          transferLabel="Transfer"
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
