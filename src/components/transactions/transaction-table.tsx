"use client";

import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";

import { ConfirmDelete } from "@/components/form/confirm-delete";
import type { Option } from "@/components/form/selects";
import { SourceBadge } from "@/components/source-badge";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { TransferDialog } from "@/components/transactions/transfer-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { transactionEditBlock } from "@/lib/transactions";
import { deleteTransactionAction } from "@/server/actions/transactions";
import { cn } from "@/lib/utils";

import type { TransactionRow } from "@/lib/data/transactions";

function AmountCell({
  row,
  displayCurrency,
}: {
  row: TransactionRow;
  displayCurrency: string;
}) {
  const sign =
    row.type === "INCOME" || row.type === "OPENING_BALANCE"
      ? "+"
      : row.type === "EXPENSE"
        ? "-"
        : "";
  // An opening balance raises the account like income but is not income, so
  // it gets the neutral transfer tone rather than the income green.
  const tone =
    row.type === "INCOME"
      ? "text-[var(--good)]"
      : row.type === "TRANSFER" || row.type === "OPENING_BALANCE"
        ? "text-muted-foreground"
        : "";

  return (
    <div className="text-right">
      <span className={cn("figure text-sm", tone)}>
        {sign}
        {formatMoney(row.displayAmount, displayCurrency)}
      </span>
      {row.currency !== displayCurrency ? (
        <p className="figure text-[0.6875rem] text-muted-foreground">
          {formatMoney(row.amount, row.currency)}
        </p>
      ) : null}
    </div>
  );
}

export function TransactionTable({
  rows,
  accounts,
  categories,
  displayCurrency,
  locale,
}: {
  rows: TransactionRow[];
  accounts: Option[];
  categories: Option[];
  displayCurrency: string;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const [editing, setEditing] = useState<TransactionRow | null>(null);
  const [deleting, setDeleting] = useState<TransactionRow | null>(null);

  const editingTransfer = editing?.transferId ? editing : null;
  const editingPlain = editing && !editing.transferId ? editing : null;

  return (
    <>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[104px]">{t.colDate}</TableHead>
              <TableHead>{t.colDescription}</TableHead>
              <TableHead className="hidden sm:table-cell">{t.colAccount}</TableHead>
              <TableHead className="hidden md:table-cell">{t.colSource}</TableHead>
              <TableHead className="text-right">{t.colAmount}</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id} className="group">
                <TableCell className="figure text-xs text-muted-foreground">
                  {toISODate(row.date)}
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm">
                      {row.note ??
                        (row.type === "TRANSFER"
                          ? (row.transferDirection === "OUT"
                              ? t.transferTo(row.counterpartAccountName ?? t.anotherAccount)
                              : t.transferFrom(row.counterpartAccountName ?? t.anotherAccount))
                          : row.type === "OPENING_BALANCE"
                            ? t.openingBalance
                            : (row.categoryName ?? t.uncategorized))}
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
                <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                  {row.accountName}
                  {row.type === "TRANSFER" && row.counterpartAccountName ? (
                    <span className="text-muted-foreground/70">
                      {row.transferDirection === "OUT" ? " → " : " ← "}
                      {row.counterpartAccountName}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <SourceBadge
                    source={row.source}
                    isTransfer={row.type === "TRANSFER"}
                    labels={common.sourceLabels}
                    transferLabel={t.transfer}
                  />
                </TableCell>
                <TableCell>
                  <AmountCell row={row} displayCurrency={displayCurrency} />
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t.rowActionsAria}
                      >
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {/* Opening balances are edited from the Accounts page so
                          they can never be re-saved as income or spending. */}
                      {transactionEditBlock(row) !== "opening_balance" ? (
                        <DropdownMenuItem onSelect={() => setEditing(row)}>
                          <Pencil className="size-3.5" />
                          {common.edit}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => setDeleting(row)}
                      >
                        <Trash2 className="size-3.5" />
                        {common.delete}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {editingPlain ? (
        <TransactionDialog
          accounts={accounts}
          categories={categories}
          locale={locale}
          open
          onOpenChange={(next) => !next && setEditing(null)}
          values={{
            id: editingPlain.id,
            date: toISODate(editingPlain.date),
            amount: editingPlain.amount,
            currency: editingPlain.currency,
            type: editingPlain.type,
            accountId: editingPlain.accountId,
            categoryId: editingPlain.categoryId ?? "none",
            note: editingPlain.note,
          }}
        />
      ) : null}

      {editingTransfer ? (
        <TransferDialog
          accounts={accounts}
          locale={locale}
          open
          onOpenChange={(next) => !next && setEditing(null)}
          values={{
            transferId: editingTransfer.transferId ?? undefined,
            date: toISODate(editingTransfer.date),
            amount: editingTransfer.amount,
            currency: editingTransfer.currency,
            fromAccountId:
              editingTransfer.transferDirection === "OUT"
                ? editingTransfer.accountId
                : (editingTransfer.counterpartAccountId ?? undefined),
            toAccountId:
              editingTransfer.transferDirection === "IN"
                ? editingTransfer.accountId
                : (editingTransfer.counterpartAccountId ?? undefined),
            note: editingTransfer.note,
          }}
        />
      ) : null}

      {deleting ? (
        <ConfirmDelete
          id={deleting.id}
          action={deleteTransactionAction}
          open
          onOpenChange={(next) => !next && setDeleting(null)}
          title={deleting.transferId ? t.deleteTransferTitle : t.deleteTransactionTitle}
          description={
            deleting.transferId
              ? t.deleteTransferDescription
              : t.deleteTransactionDescription
          }
          confirmLabel={common.delete}
          keepLabel={common.keepIt}
          deletedMessage={common.deleted}
        />
      ) : null}
    </>
  );
}
