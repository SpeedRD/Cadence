"use client";

import { Lock, MoreHorizontal, Pencil, Sparkles, Trash2 } from "lucide-react";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ConfirmDelete } from "@/components/form/confirm-delete";
import type { Option } from "@/components/form/selects";
import { SourceBadge } from "@/components/source-badge";
import {
  ReimbursementBadge,
  ReimbursementProgressLine,
  SharedExpenseBadge,
} from "@/components/transactions/shared-expense-badges";
import { TransactionDialog } from "@/components/transactions/transaction-dialog";
import { TransferDialog } from "@/components/transactions/transfer-dialog";
import { Badge } from "@/components/ui/badge";
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
import { canBeExtraordinary, transactionEditBlock } from "@/lib/transactions";
import { deleteTransactionAction, setExtraordinaryAction } from "@/server/actions/transactions";
import { cn } from "@/lib/utils";

import type { OpenSharedExpense, TransactionRow } from "@/lib/data/transactions";

/** The sign and tone every amount on this page is shown with. */
function amountStyle(row: TransactionRow) {
  const sign =
    row.type === "INCOME" || row.type === "OPENING_BALANCE"
      ? "+"
      : row.type === "EXPENSE"
        ? "-"
        : "";
  // An opening balance raises the account like income but is not income, and
  // an external transfer moves value like an internal transfer leg but has
  // no Cadence-side counterparty - both get the neutral transfer tone rather
  // than the income green or a directional sign.
  const tone =
    row.type === "INCOME"
      ? "text-[var(--good)]"
      : row.type === "TRANSFER" || row.type === "OPENING_BALANCE" || row.type === "EXTERNAL_TRANSFER"
        ? "text-muted-foreground"
        : "";
  return { sign, tone };
}

function AmountCell({
  row,
  displayCurrency,
}: {
  row: TransactionRow;
  displayCurrency: string;
}) {
  const { sign, tone } = amountStyle(row);

  return (
    <div className="text-right">
      <span className={cn("figure text-sm", tone)}>
        {sign}
        {formatMoney(row.displayAmount, displayCurrency)}
      </span>
      {row.currency !== displayCurrency ? (
        <p className="figure figure-sm text-[0.6875rem] text-muted-foreground">
          {formatMoney(row.amount, row.currency)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The transfer form is filled from the sending leg - whichever leg was
 * clicked - and the receiving leg's figure is offered as the declared
 * received amount only when it differs, i.e. when a cross-currency transfer
 * was recorded with what the bank actually credited.
 */
function transferFormValues(row: TransactionRow) {
  const isOut = row.transferDirection === "OUT";
  const outAmount = isOut ? row.amount : (row.counterpartAmount ?? row.amount);
  const outCurrency = isOut ? row.currency : (row.counterpartCurrency ?? row.currency);
  const inAmount = isOut ? row.counterpartAmount : row.amount;
  const inCurrency = isOut ? row.counterpartCurrency : row.currency;
  const declaredReceived =
    inAmount !== null && (inAmount !== outAmount || inCurrency !== outCurrency) ? inAmount : undefined;
  return {
    transferId: row.transferId ?? undefined,
    date: toISODate(row.date),
    amount: outAmount,
    currency: outCurrency,
    fromAccountId: isOut ? row.accountId : (row.counterpartAccountId ?? undefined),
    toAccountId: isOut ? (row.counterpartAccountId ?? undefined) : row.accountId,
    note: row.note,
    receivedAmount: declaredReceived,
  };
}

type Dictionary = ReturnType<typeof getDictionary>;

/** The row's headline: its note, or what kind of row it is when it has none. */
function rowTitle(row: TransactionRow, t: Dictionary["transactions"]) {
  return (
    row.note ??
    (row.type === "TRANSFER"
      ? (row.transferDirection === "OUT"
          ? t.transferTo(row.counterpartAccountName ?? t.anotherAccount)
          : t.transferFrom(row.counterpartAccountName ?? t.anotherAccount))
      : row.type === "EXTERNAL_TRANSFER"
        ? (row.transferDirection === "OUT" ? t.externalTransferOut : t.externalTransferIn)
        : row.type === "OPENING_BALANCE"
          ? t.openingBalance
          : (row.categoryName ?? t.uncategorized))
  );
}

/** Whether the row menu offers Edit - see the comment in RowMenuItems. */
function isEditable(row: TransactionRow) {
  const block = transactionEditBlock(row);
  return (
    block !== "payday_income" &&
    block !== "goal_contribution" &&
    !row.hasLinkedGoalContribution &&
    block !== "opening_balance"
  );
}

/**
 * The row menu's items. On a phone the whole row is the Edit target, so the
 * list passes no onEdit and its menu keeps only the one-off toggle, Delete
 * and the lock notices.
 */
function RowMenuItems({
  row,
  dictionary,
  onEdit,
  onToggleExtraordinary,
  onDelete,
}: {
  row: TransactionRow;
  dictionary: Dictionary;
  onEdit?: () => void;
  onToggleExtraordinary: () => void;
  onDelete: () => void;
}) {
  const t = dictionary.transactions;
  const common = dictionary.common;
  return (
    <>
      {/* Opening balances are edited from the Accounts page so
          they can never be re-saved as income or spending. A
          paycheck a payday check-in recorded belongs to that
          check-in's snapshot, so it is neither edited nor
          deleted here (the actions refuse both) - re-run the
          check-in instead. The expense a goal contribution
          wrote - logged by hand (transactionEditBlock knows
          it) or posted by a recurring item (only the
          loader's lookup knows, see hasLinkedGoalContribution)
          - is changed from the goal's page, so both halves
          of the pair stay in step. */}
      {transactionEditBlock(row) === "payday_income" ? (
        <DropdownMenuItem disabled>
          <Lock className="size-3.5" />
          {t.paycheckLocked}
        </DropdownMenuItem>
      ) : transactionEditBlock(row) === "goal_contribution" ||
        row.hasLinkedGoalContribution ? (
        <DropdownMenuItem disabled>
          <Lock className="size-3.5" />
          {t.editContributionFromGoal}
        </DropdownMenuItem>
      ) : (
        <>
          {onEdit && transactionEditBlock(row) !== "opening_balance" ? (
            <DropdownMenuItem onSelect={onEdit}>
              <Pencil className="size-3.5" />
              {common.edit}
            </DropdownMenuItem>
          ) : null}
          {/* The one-off flag, on every organic expense
              (canBeExtraordinary), whether or not the
              threshold ever suggested it. */}
          {canBeExtraordinary(row) ? (
            <DropdownMenuItem onSelect={onToggleExtraordinary}>
              <Sparkles className="size-3.5" />
              {row.isExtraordinary ? t.unmarkExtraordinary : t.markExtraordinary}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            onSelect={onDelete}
          >
            <Trash2 className="size-3.5" />
            {common.delete}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

function RowBadges({ row, locale, t }: { row: TransactionRow; locale: Locale; t: Dictionary["transactions"] }) {
  return (
    <>
      {row.isExtraordinary ? (
        <Badge variant="outline" className="h-4 px-1.5 text-[0.625rem]">
          <Sparkles className="size-2.5" />
          {t.extraordinaryBadge}
        </Badge>
      ) : null}
      {row.yourShare !== null ? (
        <SharedExpenseBadge yourShare={row.yourShare} currency={row.currency} locale={locale} />
      ) : null}
      {row.reimburses ? (
        <ReimbursementBadge reimburses={row.reimburses} locale={locale} />
      ) : null}
    </>
  );
}

/**
 * The phone ledger (below `sm`): rows grouped under a day header, each a
 * two-line grid (see the row body below). The row itself opens the edit
 * dialog; the menu keeps the rest.
 */
function MobileLedger({
  rows,
  dictionary,
  displayCurrency,
  locale,
  onEdit,
  onToggleExtraordinary,
  onDelete,
}: {
  rows: TransactionRow[];
  dictionary: Dictionary;
  displayCurrency: string;
  locale: Locale;
  onEdit: (row: TransactionRow) => void;
  onToggleExtraordinary: (row: TransactionRow) => void;
  onDelete: (row: TransactionRow) => void;
}) {
  const t = dictionary.transactions;
  const common = dictionary.common;
  // Rows arrive date-descending, so consecutive runs are the days.
  const days: { day: string; rows: TransactionRow[] }[] = [];
  for (const row of rows) {
    const day = toISODate(row.date);
    if (days.at(-1)?.day === day) days.at(-1)!.rows.push(row);
    else days.push({ day, rows: [row] });
  }

  return (
    <div className="sm:hidden">
      {days.map(({ day, rows: dayRows }) => (
        <section key={day} className="border-b last:border-b-0">
          <h2 className="eyebrow border-b px-4 pt-4 pb-1.5">{day}</h2>
          <ul className="divide-y">
            {dayRows.map((row) => {
              const { sign, tone } = amountStyle(row);
              const native = row.currency !== displayCurrency;
              // Line 1: description | signed amount. Line 2: category,
              // account and source | the native-currency figure when it
              // differs - without one, line 2 takes the full width. Nothing
              // truncates: a locked row has no dialog to show the rest in.
              const body = (
                <>
                  <span className="text-sm break-words">{rowTitle(row, t)}</span>
                  <span className={cn("figure text-right text-sm", tone)}>
                    {sign}
                    {formatMoney(row.displayAmount, displayCurrency)}
                  </span>
                  <span
                    className={cn(
                      "flex min-w-0 items-start gap-1.5 text-[0.6875rem] text-muted-foreground",
                      !native && "col-span-2",
                    )}
                  >
                    {row.categoryName ? (
                      <span
                        className="mt-[0.3125rem] size-1.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: row.categoryColor ?? "var(--muted-foreground)",
                        }}
                      />
                    ) : null}
                    <span className="min-w-0 pt-0.5 break-words">
                      {row.categoryName ? `${row.categoryName} · ` : null}
                      {row.accountName}
                      {row.type === "TRANSFER" && row.counterpartAccountName ? (
                        <span className="text-muted-foreground/70">
                          {row.transferDirection === "OUT" ? " → " : " ← "}
                          {row.counterpartAccountName}
                        </span>
                      ) : null}
                    </span>
                    <SourceBadge
                      source={row.source}
                      isTransfer={row.type === "TRANSFER" || row.type === "EXTERNAL_TRANSFER"}
                      labels={common.sourceLabels}
                      transferLabel={row.type === "EXTERNAL_TRANSFER" ? t.externalTransferBadge : t.transfer}
                      className="shrink-0"
                    />
                  </span>
                  {native ? (
                    <span className="figure figure-sm pt-0.5 text-right text-[0.6875rem] text-muted-foreground">
                      {formatMoney(row.amount, row.currency)}
                    </span>
                  ) : null}
                  {row.isExtraordinary || row.yourShare !== null || row.reimburses ? (
                    <span className="col-span-2 flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                      <RowBadges row={row} locale={locale} t={t} />
                    </span>
                  ) : null}
                  {row.reimbursement ? (
                    <span className="col-span-2">
                      <ReimbursementProgressLine
                        progress={row.reimbursement}
                        currency={row.currency}
                        locale={locale}
                      />
                    </span>
                  ) : null}
                </>
              );
              const bodyClass =
                "grid min-h-14 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] content-start items-start gap-x-3 gap-y-0.5 py-2.5 pl-4 text-left";
              return (
                <li
                  key={row.id}
                  className="flex items-center gap-1 pr-2 transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50"
                >
                  {isEditable(row) ? (
                    <button
                      type="button"
                      onClick={() => onEdit(row)}
                      className={cn(
                        bodyClass,
                        "outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
                      )}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={bodyClass}>{body}</div>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label={t.rowActionsAria}>
                        <MoreHorizontal className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <RowMenuItems
                        row={row}
                        dictionary={dictionary}
                        onToggleExtraordinary={() => onToggleExtraordinary(row)}
                        onDelete={() => onDelete(row)}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function TransactionTable({
  rows,
  accounts,
  categories,
  openSharedExpenses,
  displayCurrency,
  locale,
}: {
  rows: TransactionRow[];
  accounts: Option[];
  categories: Option[];
  /** For the edit dialog's reimbursement picker - see TransactionDialog. */
  openSharedExpenses: OpenSharedExpense[];
  displayCurrency: string;
  locale: Locale;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const [editing, setEditing] = useState<TransactionRow | null>(null);
  const [deleting, setDeleting] = useState<TransactionRow | null>(null);

  // The one-off toggle needs no input beyond the row, so it is one shared
  // action for the whole table, fired straight from the row menu.
  const [toggleState, toggleAction] = useActionState(setExtraordinaryAction, null);
  const handledToggle = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!toggleState || toggleState.at === handledToggle.current) return;
    handledToggle.current = toggleState.at;
    if (toggleState.ok) toast.success(toggleState.message ?? common.saved);
    else if (toggleState.error) toast.error(toggleState.error);
  }, [toggleState, common.saved]);
  const toggleExtraordinary = (row: TransactionRow) => {
    const formData = new FormData();
    formData.set("id", row.id);
    formData.set("isExtraordinary", row.isExtraordinary ? "false" : "true");
    startTransition(() => toggleAction(formData));
  };

  const editingTransfer = editing?.transferId ? editing : null;
  const editingPlain = editing && !editing.transferId ? editing : null;

  return (
    <>
      <div className="hidden overflow-x-auto sm:block">
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
                <TableCell className="figure figure-sm text-xs text-muted-foreground">
                  {toISODate(row.date)}
                </TableCell>
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm">
                      {rowTitle(row, t)}
                    </span>
                    {row.categoryName ||
                    row.isExtraordinary ||
                    row.yourShare !== null ||
                    row.reimbursesTransactionId ? (
                      <span className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                        {row.categoryName ? (
                          <>
                            <span
                              className="size-1.5 rounded-full"
                              style={{
                                backgroundColor:
                                  row.categoryColor ?? "var(--muted-foreground)",
                              }}
                            />
                            {row.categoryName}
                          </>
                        ) : null}
                        <RowBadges row={row} locale={locale} t={t} />
                      </span>
                    ) : null}
                    {row.reimbursement ? (
                      <ReimbursementProgressLine
                        progress={row.reimbursement}
                        currency={row.currency}
                        locale={locale}
                      />
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
                    isTransfer={row.type === "TRANSFER" || row.type === "EXTERNAL_TRANSFER"}
                    labels={common.sourceLabels}
                    transferLabel={row.type === "EXTERNAL_TRANSFER" ? t.externalTransferBadge : t.transfer}
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
                      <RowMenuItems
                        row={row}
                        dictionary={dictionary}
                        onEdit={() => setEditing(row)}
                        onToggleExtraordinary={() => toggleExtraordinary(row)}
                        onDelete={() => setDeleting(row)}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <MobileLedger
        rows={rows}
        dictionary={dictionary}
        displayCurrency={displayCurrency}
        locale={locale}
        onEdit={setEditing}
        onToggleExtraordinary={toggleExtraordinary}
        onDelete={setDeleting}
      />

      {editingPlain ? (
        <TransactionDialog
          accounts={accounts}
          categories={categories}
          openSharedExpenses={openSharedExpenses}
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
            transferDirection: editingPlain.transferDirection,
            yourShare: editingPlain.yourShare,
            reimbursesTransactionId: editingPlain.reimbursesTransactionId,
            source: editingPlain.source,
            externalId: editingPlain.externalId,
          }}
        />
      ) : null}

      {editingTransfer ? (
        <TransferDialog
          accounts={accounts}
          locale={locale}
          open
          onOpenChange={(next) => !next && setEditing(null)}
          values={transferFormValues(editingTransfer)}
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
