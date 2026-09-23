import { Plus } from "lucide-react";
import Link from "next/link";

import { AccountDialog } from "@/components/accounts/account-dialog";
import { AccountRowActions } from "@/components/accounts/account-row-actions";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { getAccountBalances, type AccountBalance } from "@/lib/data/accounts";
import { getAppContext } from "@/lib/data/context";
import { getDictionary, type Dictionary, type Locale } from "@/lib/i18n";
import { labelFor } from "@/lib/labels";

export const metadata = { title: "Accounts - Cadence" };

export default async function AccountsPage() {
  const context = await getAppContext();
  const t = getDictionary(context.language).accounts;
  const common = getDictionary(context.language).common;
  const [active, archived] = await Promise.all([
    getAccountBalances(context, { status: "ACTIVE" }),
    getAccountBalances(context, { status: "ARCHIVED" }),
  ]);
  const net = active.reduce((total, account) => total + account.displayBalance, 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={
          active.length > 0
            ? t.acrossAccounts(formatMoney(net, context.displayCurrency), active.length)
            : t.whereMoneySits
        }
        actions={
          <AccountDialog
            values={{ currency: context.displayCurrency }}
            locale={context.language}
            trigger={
              // Below sm, while there is an active list, this lives as the
              // list's last row instead (AccountsTable's addRow).
              <Button size="sm" className={active.length > 0 ? "max-sm:hidden" : undefined}>
                <Plus className="size-3.5" />
                {t.newAccount}
              </Button>
            }
          />
        }
      />

      {active.length === 0 && archived.length === 0 ? (
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
        <Tabs defaultValue="active">
          <TabsList>
            <TabsTrigger value="active">{t.activeTab}</TabsTrigger>
            <TabsTrigger value="archived">{t.archivedTab}</TabsTrigger>
          </TabsList>
          <TabsContent value="active">
            {active.length === 0 ? (
              <EmptyState title={t.noAccountsTitle} description={t.noAccountsDescription} />
            ) : (
              <AccountsTable
                accounts={active}
                displayCurrency={context.displayCurrency}
                locale={context.language}
                t={t}
                common={common}
                today={context.today}
                addRow={
                  <AccountDialog
                    values={{ currency: context.displayCurrency }}
                    locale={context.language}
                    trigger={
                      <Button variant="ghost" className="w-full justify-start rounded-none px-2">
                        <Plus className="size-3.5" />
                        {t.newAccount}
                      </Button>
                    }
                  />
                }
              />
            )}
          </TabsContent>
          <TabsContent value="archived">
            {archived.length === 0 ? (
              <EmptyState
                title={t.noArchivedAccountsTitle}
                description={t.noArchivedAccountsDescription}
              />
            ) : (
              <AccountsTable
                accounts={archived}
                displayCurrency={context.displayCurrency}
                locale={context.language}
                t={t}
                common={common}
                today={context.today}
              />
            )}
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function AccountsTable({
  accounts,
  displayCurrency,
  locale,
  t,
  common,
  today,
  addRow,
}: {
  accounts: AccountBalance[];
  displayCurrency: string;
  locale: Locale;
  t: Dictionary["accounts"];
  common: Dictionary["common"];
  today: Date;
  /**
   * Below sm, the page's "New account" as the list's last row: the list is
   * short and fits the screen, so its end is mid-screen, in thumb reach, the
   * way iOS Settings ends an accounts list with "Add Account". In the
   * table's own footer band; hidden from sm up, where the header has it.
   */
  addRow?: React.ReactNode;
}) {
  return (
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
                  <p className="figure figure-sm text-hint text-muted-foreground">
                    {account.currency}
                    {account.status === "ARCHIVED" ? (
                      <Badge variant="outline" className="ml-1.5 align-middle">
                        {t.archivedBadge}
                      </Badge>
                    ) : null}
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
                  {account.currency !== displayCurrency ? (
                    <p className="figure figure-sm text-hint text-muted-foreground">
                      {formatMoney(account.displayBalance, displayCurrency)}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  <AccountRowActions account={account} locale={locale} today={today} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
          {addRow ? (
            <TableFooter className="sm:hidden">
              <TableRow>
                <TableCell colSpan={3} className="p-0">
                  {addRow}
                </TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </CardContent>
    </Card>
  );
}
