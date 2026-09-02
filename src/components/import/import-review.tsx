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
import type { DetectedGroup } from "@/lib/import-grouping";

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
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const common = dictionary.common;
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
            <div className="mt-3 overflow-x-auto rounded-md border border-border/50">
              <RowsTable
                rows={unknownRowIndexes.map((index) => rows[index])}
                currency={currency}
                common={common}
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
    note: group.sampleNote,
  };
  const transferValues = {
    date: toISODate(latestDate),
    amount: rows[rows.length - 1]?.amount,
    currency,
    fromAccountId: accountId,
    note: group.sampleNote,
  };

  const badge =
    group.kind === "transfer"
      ? { label: t.possibleTransfer, variant: "outline" as const }
      : group.possibleSubscription
        ? { label: t.possibleSubscription, variant: "secondary" as const }
        : group.suggestedCategoryName
          ? { label: t.suggestedCategory(group.suggestedCategoryName), variant: "outline" as const }
          : null;

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

      {decision !== undefined ? (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-muted-foreground">
            {decision === EXPLICIT_NO_CATEGORY
              ? group.kind === "transfer"
                ? t.appliedLeaveAsExpense
                : t.appliedUncategorized
              : t.appliedCategory(
                  categories.find((category) => category.id === decision)?.name ?? "",
                )}
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => onDecideAction(undefined)}>
            {t.changeDecision}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {group.kind === "transfer" ? (
            <>
              <TransferDialog
                accounts={accounts}
                values={transferValues}
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
                onClick={() => onDecideAction(EXPLICIT_NO_CATEGORY)}
              >
                {t.leaveAsExpense}
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
                  <SelectTrigger size="sm" className="h-6 w-40 text-xs">
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
