"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Option } from "@/components/form/selects";
import { RecurringDialog } from "@/components/recurring/recurring-dialog";
import { TransferDialog } from "@/components/transactions/transfer-dialog";
import { EXPLICIT_NO_CATEGORY } from "@/lib/categorization-rules";
import { formatMoney } from "@/lib/currency";
import { toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { buildTransferPrefill, type DetectedGroup } from "@/lib/import-grouping";

export interface ReviewRow {
  date: Date;
  amount: number;
  note: string;
  type: "EXPENSE" | "INCOME";
}

/**
 * The grouped review layer between preview and final import. Never mutates
 * the underlying rows itself - it only produces a `decisions` map (group id ->
 * chosen categoryId, or EXPLICIT_NO_CATEGORY) that the caller folds into the
 * per-row payload. Creating a recurring item or a transfer happens through
 * the existing dialogs/actions, entirely independent of the import batch.
 */
export function ImportReview({
  groups,
  unknownRowIndexes,
  rows,
  categories,
  accounts,
  currency,
  accountId,
  locale,
  decisions,
  onDecideAction,
  unknownDecisions,
  onDecideUnknownAction,
  typeDecisions,
  onDecideTypeAction,
}: {
  groups: DetectedGroup[];
  unknownRowIndexes: number[];
  rows: ReviewRow[];
  categories: Option[];
  accounts: Option[];
  currency: string;
  accountId: string;
  locale: Locale;
  decisions: Record<string, string>;
  onDecideAction: (groupId: string, categoryId: string | undefined) => void;
  /** Per-row decisions for the "unknown merchants" bucket - keyed by the same
   *  row index as `rows`, independent of the grouped decisions above. */
  unknownDecisions: Record<number, string>;
  onDecideUnknownAction: (rowIndexes: number[], categoryId: string) => void;
  /** "Mark as income" decisions for incoming transfer-shaped groups - a
   *  transaction-type override, never a category assignment (see GroupCard). */
  typeDecisions: Record<string, string>;
  onDecideTypeAction: (groupId: string, typeOverride: string | undefined) => void;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const [unknownExpanded, setUnknownExpanded] = useState(false);

  const categoryIdByName = new Map(
    categories.map((category) => [category.name.toLowerCase(), category.id]),
  );

  if (groups.length === 0 && unknownRowIndexes.length === 0) return null;

  return (
    <div className="space-y-3 rounded-md border border-border/70 p-4">
      <div>
        <p className="text-sm font-medium">{t.detectedPatternsTitle}</p>
        <p className="text-xs text-muted-foreground">{t.detectedPatternsDescription}</p>
      </div>

      <div className="space-y-2">
        {groups.map((group) => (
          <GroupCard
            key={group.id}
            group={group}
            rows={group.rowIndexes.map((index) => rows[index])}
            categories={categories}
            categoryIdByName={categoryIdByName}
            accounts={accounts}
            currency={currency}
            accountId={accountId}
            locale={locale}
            decision={decisions[group.id]}
            onDecideAction={(categoryId) => onDecideAction(group.id, categoryId)}
            typeDecision={typeDecisions[group.id]}
            onDecideTypeAction={(typeOverride) => onDecideTypeAction(group.id, typeOverride)}
          />
        ))}
      </div>

      {unknownRowIndexes.length > 0 ? (
        <div className="rounded-md border border-border/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t.unknownMerchantsTitle}</p>
              <p className="text-xs text-muted-foreground">
                {t.patternRowCount(unknownRowIndexes.length)}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setUnknownExpanded((value) => !value)}
            >
              {t.reviewIndividually}
              {unknownExpanded ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          </div>
          {unknownExpanded ? (
            <div className="mt-3">
              <UnknownRowsPanel
                rowIndexes={unknownRowIndexes}
                rows={rows}
                categories={categories}
                currency={currency}
                locale={locale}
                decisions={unknownDecisions}
                onDecideAction={onDecideUnknownAction}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function GroupCard({
  group,
  rows,
  categories,
  categoryIdByName,
  accounts,
  currency,
  accountId,
  locale,
  decision,
  onDecideAction,
  typeDecision,
  onDecideTypeAction,
}: {
  group: DetectedGroup;
  rows: ReviewRow[];
  categories: Option[];
  categoryIdByName: Map<string, string>;
  accounts: Option[];
  currency: string;
  accountId: string;
  locale: Locale;
  decision: string | undefined;
  onDecideAction: (categoryId: string | undefined) => void;
  /** "Mark as income" for an incoming transfer-shaped group - a type
   *  override, tracked separately from `decision` (category) per group. */
  typeDecision: string | undefined;
  onDecideTypeAction: (typeOverride: string | undefined) => void;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const [expanded, setExpanded] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const suggestedCategoryId = group.suggestedCategoryName
    ? categoryIdByName.get(group.suggestedCategoryName.toLowerCase())
    : undefined;
  const subscriptionsId = categoryIdByName.get("subscriptions");

  const latestDate = rows.reduce((latest, row) => (row.date > latest ? row.date : latest), rows[0].date);
  const recurringValues = {
    name: group.displayName,
    amount: rows[0].amount,
    currency,
    frequency: group.inferredFrequency,
    kind: "SUBSCRIPTION",
    nextDate: toISODate(group.inferredNextDate),
    categoryId: subscriptionsId ?? "none",
    accountId,
    note: group.sampleNote,
  };

  const isIncomingTransfer = group.kind === "transfer" && group.transferDirection === "IN";
  const isOutgoingTransfer = group.kind === "transfer" && group.transferDirection === "OUT";

  const transferValues = group.transferDirection
    ? buildTransferPrefill({
        direction: group.transferDirection,
        accountId,
        date: toISODate(latestDate),
        amount: rows[rows.length - 1]?.amount ?? 0,
        currency,
        note: group.sampleNote,
      })
    : undefined;

  const badge =
    group.kind === "transfer"
      ? { label: t.possibleTransfer, variant: "outline" as const }
      : group.possibleSubscription
        ? { label: t.possibleSubscription, variant: "secondary" as const }
        : group.suggestedCategoryName
          ? { label: t.suggestedCategory(group.suggestedCategoryName), variant: "outline" as const }
          : null;

  // A transfer-shaped group resolves via either the separate type decision
  // (Mark as income / Record as external transfer) or the category decision
  // channel (Leave as expense), never requiring both.
  const isTransferGroup = group.kind === "transfer";
  const resolved = isTransferGroup
    ? typeDecision !== undefined || decision !== undefined
    : decision !== undefined;

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{group.displayName}</p>
          <p className="text-xs text-muted-foreground">
            {t.patternRowCount(group.count)} · {formatMoney(group.totalAmount, currency)}
          </p>
        </div>
        {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
      </div>

      {resolved ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            {typeDecision === "INCOME"
              ? t.appliedMarkedAsIncome
              : typeDecision === "EXTERNAL_TRANSFER"
                ? t.appliedExternalTransfer
                : decision === EXPLICIT_NO_CATEGORY
                  ? group.kind === "transfer"
                    ? t.appliedLeaveAsExpense
                    : t.appliedUncategorized
                  : t.appliedCategory(
                      categories.find((category) => category.id === decision)?.name ?? "",
                    )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => (typeDecision !== undefined ? onDecideTypeAction(undefined) : onDecideAction(undefined))}
          >
            {t.changeDecision}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {isOutgoingTransfer ? (
            <>
              <TransferDialog
                accounts={accounts}
                values={transferValues!}
                locale={locale}
                trigger={
                  <Button type="button" variant="outline" size="xs">
                    {t.reviewGroup}
                  </Button>
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideTypeAction("EXTERNAL_TRANSFER")}
              >
                {t.recordAsExternalTransfer}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideAction(EXPLICIT_NO_CATEGORY)}
              >
                {t.leaveAsExpense}
              </Button>
            </>
          ) : isIncomingTransfer ? (
            <>
              <TransferDialog
                accounts={accounts}
                values={transferValues!}
                locale={locale}
                trigger={
                  <Button type="button" variant="outline" size="xs">
                    {t.reviewGroup}
                  </Button>
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideTypeAction("EXTERNAL_TRANSFER")}
              >
                {t.recordAsExternalTransfer}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideTypeAction("INCOME")}
              >
                {t.markAsIncome}
              </Button>
            </>
          ) : (
            <>
              {suggestedCategoryId ? (
                <Button type="button" size="xs" onClick={() => onDecideAction(suggestedCategoryId)}>
                  {t.acceptCategory(group.suggestedCategoryName as string)}
                </Button>
              ) : group.possibleSubscription && subscriptionsId ? (
                <Button type="button" size="xs" onClick={() => onDecideAction(subscriptionsId)}>
                  {t.categorizeAsSubscriptions}
                </Button>
              ) : null}
              {choosing ? (
                <Select
                  onValueChange={(value) => {
                    onDecideAction(value);
                    setChoosing(false);
                  }}
                >
                  <SelectTrigger size="sm" className="h-8 w-40 text-xs sm:h-6">
                    <SelectValue placeholder={common.pickACategory} />
                  </SelectTrigger>
                  <SelectContent>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Button type="button" variant="outline" size="xs" onClick={() => setChoosing(true)}>
                  {t.chooseCategory}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => onDecideAction(EXPLICIT_NO_CATEGORY)}
              >
                {t.leaveUncategorized}
              </Button>
              {group.possibleSubscription ? (
                <RecurringDialog
                  categories={categories}
                  accounts={accounts}
                  values={recurringValues}
                  locale={locale}
                  trigger={
                    <Button type="button" variant="outline" size="xs">
                      {t.createRecurringItem}
                    </Button>
                  }
                />
              ) : null}
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t.hideRows : t.showRows(group.count)}
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </Button>
        </div>
      )}

      {expanded ? (
        <div className="overflow-x-auto rounded-md border border-border/50">
          <RowsTable rows={rows} currency={currency} common={common} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The "unknown merchants" bucket: rows that matched no repeated pattern and
 * have no automatic suggestion. Unlike a detected group, these rows have
 * nothing in common except "uncategorized" - so instead of one bulk action
 * for the whole bucket, the user picks which rows to act on. Selection is
 * local, transient UI state; only the resulting per-row decision (categoryId
 * or EXPLICIT_NO_CATEGORY) is reported to the caller.
 */
function UnknownRowsPanel({
  rowIndexes,
  rows,
  categories,
  currency,
  locale,
  decisions,
  onDecideAction,
}: {
  rowIndexes: number[];
  rows: ReviewRow[];
  categories: Option[];
  currency: string;
  locale: Locale;
  decisions: Record<number, string>;
  onDecideAction: (rowIndexes: number[], categoryId: string) => void;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const allSelected = rowIndexes.length > 0 && rowIndexes.every((index) => selected.has(index));

  const toggleRow = (index: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(rowIndexes));
  };

  const applyToSelected = (categoryId: string) => {
    if (selected.size === 0) return;
    onDecideAction(Array.from(selected), categoryId);
    setSelected(new Set());
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            className="size-3.5 rounded-sm border-border accent-primary"
            checked={allSelected}
            onChange={toggleAll}
            aria-label={t.selectAllAria}
          />
          {t.selectedCount(selected.size)}
        </label>
        {selected.size > 0 ? (
          <>
            <Select onValueChange={applyToSelected}>
              <SelectTrigger size="sm" className="h-8 w-40 text-xs sm:h-6">
                <SelectValue placeholder={common.pickACategory} />
              </SelectTrigger>
              <SelectContent>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => applyToSelected(EXPLICIT_NO_CATEGORY)}
            >
              {t.leaveUncategorized}
            </Button>
          </>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-md border border-border/50">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-28">{common.date}</TableHead>
              <TableHead>{common.note}</TableHead>
              <TableHead className="w-32 text-right">{common.amount}</TableHead>
              <TableHead className="w-36">{common.category}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rowIndexes.map((index) => {
              const row = rows[index];
              const decision = decisions[index];
              return (
                <TableRow key={index}>
                  <TableCell>
                    <input
                      type="checkbox"
                      className="size-3.5 rounded-sm border-border accent-primary"
                      checked={selected.has(index)}
                      onChange={() => toggleRow(index)}
                      aria-label={t.selectRowAria}
                    />
                  </TableCell>
                  <TableCell className="figure text-xs">{toISODate(row.date)}</TableCell>
                  <TableCell className="max-w-[22rem] truncate text-sm">{row.note || "-"}</TableCell>
                  <TableCell className="text-right">
                    <span className="figure text-sm">{formatMoney(row.amount, currency)}</span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {decision === undefined
                      ? "-"
                      : decision === EXPLICIT_NO_CATEGORY
                        ? t.appliedUncategorized
                        : (categories.find((category) => category.id === decision)?.name ?? "-")}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function RowsTable({
  rows,
  currency,
  common,
}: {
  rows: ReviewRow[];
  currency: string;
  common: ReturnType<typeof getDictionary>["common"];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-28">{common.date}</TableHead>
          <TableHead>{common.note}</TableHead>
          <TableHead className="w-32 text-right">{common.amount}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, index) => (
          <TableRow key={index}>
            <TableCell className="figure text-xs">{toISODate(row.date)}</TableCell>
            <TableCell className="max-w-[22rem] truncate text-sm">{row.note || "-"}</TableCell>
            <TableCell className="text-right">
              <span className="figure text-sm">{formatMoney(row.amount, currency)}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
