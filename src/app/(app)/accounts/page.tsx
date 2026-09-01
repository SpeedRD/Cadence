import { Plus } from "lucide-react";
import Link from "next/link";

import { AccountDialog } from "@/components/accounts/account-dialog";
import { AccountRowActions } from "@/components/accounts/account-row-actions";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
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
import { getAccountBalances } from "@/lib/data/accounts";
import { getAppContext } from "@/lib/data/context";
import { ACCOUNT_TYPE_LABELS, labelFor } from "@/lib/labels";

export const metadata = { title: "Accounts - Cadence" };

export default async function AccountsPage() {
  const context = await getAppContext();
  const accounts = await getAccountBalances(context);
  const net = accounts.reduce((total, account) => total + account.displayBalance, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Accounts"
        description={
          accounts.length > 0
            ? `${formatMoney(net, context.displayCurrency)} across ${accounts.length} account${accounts.length === 1 ? "" : "s"}`
            : "Where your money sits."
        }
        actions={
          <AccountDialog
            values={{ currency: context.displayCurrency }}
            trigger={
              <Button size="sm">
                <Plus className="size-3.5" />
                New account
              </Button>
            }
          />
        }
      />

      {accounts.length === 0 ? (
        <EmptyState
          title="No accounts yet"
          description="Add the accounts you actually use - checking, savings, cash - and everything else hangs off them."
          action={
            <AccountDialog
              values={{ currency: context.displayCurrency }}
              trigger={<Button size="sm">Add your first account</Button>}
            />
          }
        />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Account</TableHead>
                  <TableHead className="hidden sm:table-cell">Type</TableHead>
                  <TableHead className="hidden sm:table-cell">Activity</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell>
                      <Link
                        href={`/accounts/${account.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {account.name}
                      </Link>
                      <p className="figure text-[0.6875rem] text-muted-foreground">
                        {account.currency}
                      </p>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                      {labelFor(ACCOUNT_TYPE_LABELS, account.type)}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground tnum sm:table-cell">
                      {account.transactionCount} transaction
                      {account.transactionCount === 1 ? "" : "s"}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="figure text-sm">
                        {formatMoney(account.balance, account.currency)}
                      </span>
                      {account.currency !== context.displayCurrency ? (
                        <p className="figure text-[0.6875rem] text-muted-foreground">
                          {formatMoney(account.displayBalance, context.displayCurrency)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <AccountRowActions account={account} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
