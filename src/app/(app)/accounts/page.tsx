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
import { getDictionary } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";

export const metadata = { title: "Accounts - Cadence" };

export default async function AccountsPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).accounts;
  const common = getDictionary(context.language).common;
  const accounts = await getAccountBalances(context);
  const net = accounts.reduce((total, account) => total + account.displayBalance, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={
          accounts.length > 0
            ? t.acrossAccounts(formatMoney(net, context.displayCurrency), accounts.length)
            : t.whereMoneySits
        }
        actions={
          <AccountDialog
            values={{ currency: context.displayCurrency }}
            locale={context.language}
            trigger={
              <Button size="sm">
                <Plus className="size-3.5" />
                {t.newAccount}
              </Button>
            }
          />
        }
      />

      {accounts.length === 0 ? (
        <EmptyState
          title={t.noAccountsTitle}
          description={t.noAccountsDescription}
          action={
            <AccountDialog
              values={{ currency: context.displayCurrency }}
              locale={context.language}
              trigger={<Button size="sm">{t.addFirstAccount}</Button>}
            />
          }
        />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{common.account}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t.colType}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t.colActivity}</TableHead>
                  <TableHead className="text-right">{t.colBalance}</TableHead>
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
                      {labelFor(common.accountTypeLabels, account.type)}
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground tnum sm:table-cell">
                      {t.transactionCount(account.transactionCount)}
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
                      <AccountRowActions account={account} locale={context.language} />
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
