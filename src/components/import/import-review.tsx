"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
import { PostedMatchNotice } from "@/components/transactions/posted-match-notice";
import { TransferDialog } from "@/components/transactions/transfer-dialog";
import { EXPLICIT_NO_CATEGORY } from "@/lib/categorization-rules";
import { formatMoney } from "@/lib/currency";
import { toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import { buildTransferPrefill, type DetectedGroup } from "@/lib/import-grouping";
import { nextDueOfImportedSeries } from "@/lib/recurring-detection";
import type { CsvDuplicateHit, CsvExtraordinaryHit } from "@/server/actions/import";

/**
 * A row's answer in the possible-duplicates group: imported, skipped, or -
 * for a row matching an upcoming payment in another currency - imported as
 * that payment ("It's that payment"), which posting then never charges.
 */
export type DuplicateDecision = "import" | "skip" | "settle";

/**
 * What a possible duplicate does when the user has not chosen: a re-import, or
 * an exact match for a posted charge or recorded paycheck, is skipped; a
 * possible match (planPostedDuplicates) is only a warning and imports, as its
 * own charge for an upcoming payment until the user says it is that payment.
 */
export function defaultDuplicateDecision(hit: CsvDuplicateHit): DuplicateDecision {
  return hit.kind === "posted" && hit.match.possible ? "import" : "skip";
}

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
  today,
  decisions,
  onDecideAction,
  unknownDecisions,
  onDecideUnknownAction,
  typeDecisions,
  onDecideTypeAction,
  duplicateRowIndexes,
  duplicateHits,
  duplicateDecisions,
  onDecideDuplicateAction,
  extraordinaryRowIndexes,
  extraordinaryHits,
  extraordinaryDecisions,
  onDecideExtraordinaryAction,
}: {
  groups: DetectedGroup[];
  unknownRowIndexes: number[];
  rows: ReviewRow[];
  categories: Option[];
  accounts: Option[];
  currency: string;
  accountId: string;
  locale: Locale;
  /** The app's business date: a pre-filled next due date is never before it. */
  today: Date;
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
  /** Rows the server found already imported from a CSV into this account (see detectCsvDuplicatesAction). */
  duplicateRowIndexes: number[];
  duplicateHits: Record<number, CsvDuplicateHit>;
  /** Per-row choice; a row with no entry takes defaultDuplicateDecision. */
  duplicateDecisions: Record<number, DuplicateDecision>;
  onDecideDuplicateAction: (rowIndexes: number[], decision: DuplicateDecision) => void;
  /** Rows the server found unusually large for their category (see detectCsvExtraordinaryAction). */
  extraordinaryRowIndexes: number[];
  extraordinaryHits: Record<number, CsvExtraordinaryHit>;
  /** Per-row verdict; a row with no entry imports as normal spending. */
  extraordinaryDecisions: Record<number, "extraordinary" | "normal">;
  onDecideExtraordinaryAction: (rowIndexes: number[], decision: "extraordinary" | "normal") => void;
}) {
  const dictionary = getDictionary(locale);
  const t = dictionary.transactions;
  const [unknownExpanded, setUnknownExpanded] = useState(false);
  const [duplicatesExpanded, setDuplicatesExpanded] = useState(true);
  const [extraordinaryExpanded, setExtraordinaryExpanded] = useState(true);

  const categoryIdByName = new Map(
    categories.map((category) => [category.name.toLowerCase(), category.id]),
  );

  if (
    groups.length === 0 &&
    unknownRowIndexes.length === 0 &&
    duplicateRowIndexes.length === 0 &&
    extraordinaryRowIndexes.length === 0
  ) {
    return null;
  }

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
            today={today}
            decision={decisions[group.id]}
            onDecideAction={(categoryId) => onDecideAction(group.id, categoryId)}
            typeDecision={typeDecisions[group.id]}
            onDecideTypeAction={(typeOverride) => onDecideTypeAction(group.id, typeOverride)}
          />
        ))}
      </div>

      {duplicateRowIndexes.length > 0 ? (
        <div className="rounded-md border border-border/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t.possibleDuplicatesTitle}</p>
              <p className="text-xs text-muted-foreground">
                {t.patternRowCount(duplicateRowIndexes.length)}
                {duplicateRowIndexes.some((index) => duplicateHits[index]?.kind === "imported")
                  ? ` · ${t.possibleDuplicatesDescription}`
                  : null}
              </p>
              {duplicateRowIndexes.some((index) => {
                const hit = duplicateHits[index];
                return hit?.kind === "posted" && hit.match.kind !== "upcoming";
              }) ? (
                <p className="text-xs text-muted-foreground">{t.postedDuplicatesDescription}</p>
              ) : null}
              {duplicateRowIndexes.some((index) => {
                const hit = duplicateHits[index];
                return hit?.kind === "posted" && hit.match.kind === "upcoming";
              }) ? (
                <p className="text-xs text-muted-foreground">{t.upcomingDuplicatesDescription}</p>
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setDuplicatesExpanded((value) => !value)}
            >
              {t.reviewIndividually}
              {duplicatesExpanded ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          </div>
          {duplicatesExpanded ? (
            <div className="mt-3">
              <DuplicateRowsPanel
                rowIndexes={duplicateRowIndexes}
                rows={rows}
                hits={duplicateHits}
                currency={currency}
                locale={locale}
                decisions={duplicateDecisions}
                onDecideAction={onDecideDuplicateAction}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {extraordinaryRowIndexes.length > 0 ? (
        <div className="rounded-md border border-border/50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">{t.possibleExtraordinaryTitle}</p>
              <p className="text-xs text-muted-foreground">
                {t.patternRowCount(extraordinaryRowIndexes.length)} · {t.possibleExtraordinaryDescription}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setExtraordinaryExpanded((value) => !value)}
            >
              {t.reviewIndividually}
              {extraordinaryExpanded ? (
                <ChevronUp className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </Button>
          </div>
          {extraordinaryExpanded ? (
            <div className="mt-3">
              <ExtraordinaryRowsPanel
                rowIndexes={extraordinaryRowIndexes}
                rows={rows}
                hits={extraordinaryHits}
                currency={currency}
                locale={locale}
                decisions={extraordinaryDecisions}
                onDecideAction={onDecideExtraordinaryAction}
              />
            </div>
          ) : null}
        </div>
      ) : null}

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
  today,
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
  today: Date;
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
  // On or after today, and on the series' own day of the month: a month-end
  // series pre-fills its next month-end and carries the 31st as the anchor.
  const nextDue = nextDueOfImportedSeries(
    rows.map((row) => row.date),
    group.inferredFrequency,
    today,
  );
  const recurringValues = {
    name: group.displayName,
    amount: rows[0].amount,
    currency,
    frequency: group.inferredFrequency,
    kind: "SUBSCRIPTION",
    nextDate: toISODate(nextDue.nextDate),
    anchorDay: nextDue.anchorDay,
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
                  today={today}
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
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="import-review-select-all"
            checked={allSelected}
            onCheckedChange={() => toggleAll()}
            aria-label={t.selectAllAria}
          />
          <Label
            htmlFor="import-review-select-all"
            className="text-xs font-normal text-muted-foreground"
          >
            {t.selectedCount(selected.size)}
          </Label>
        </div>
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
                    <Checkbox
                      checked={selected.has(index)}
                      onCheckedChange={() => toggleRow(index)}
                      aria-label={t.selectRowAria}
                    />
                  </TableCell>
                  <TableCell className="figure figure-sm text-xs">{toISODate(row.date)}</TableCell>
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

/**
 * The "possible duplicates" bucket: rows whose fingerprint (account, date,
 * amount, currency, description) matches a CSV row already in the ledger, and
 * rows matching a charge recurring posting already wrote or a paycheck a
 * check-in recorded (findCsvPostedDuplicates). Same shape as the
 * unknown-merchants panel - pick rows, apply one decision to them - but the
 * decision is import-or-skip, and skip is the default: a re-imported
 * statement should add nothing unless the user says so. A posted match puts
 * it as "It's the posted charge" (skip) or "It's a different charge"
 * (import), and a possible one (planPostedDuplicates) defaults to importing -
 * it is only a warning (defaultDuplicateDecision).
 */
function DuplicateRowsPanel({
  rowIndexes,
  rows,
  hits,
  currency,
  locale,
  decisions,
  onDecideAction,
}: {
  rowIndexes: number[];
  rows: ReviewRow[];
  hits: Record<number, CsvDuplicateHit>;
  currency: string;
  locale: Locale;
  decisions: Record<number, DuplicateDecision>;
  onDecideAction: (rowIndexes: number[], decision: DuplicateDecision) => void;
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
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rowIndexes));
  const applyToSelected = (decision: "import" | "skip") => {
    if (selected.size === 0) return;
    onDecideAction(Array.from(selected), decision);
    setSelected(new Set());
  };

  // One row's state and its answer, read by the card and by the table row.
  const rowView = (index: number) => {
    const row = rows[index];
    const hit = hits[index];
    const decision = decisions[index] ?? (hit ? defaultDuplicateDecision(hit) : "skip");
    const posted = hit?.kind === "posted" ? hit.match : null;
    // An upcoming payment: both answers import the row; "It's that
    // payment" also records it as that payment (settle).
    const upcoming = posted?.kind === "upcoming";
    const settling = upcoming && decision === "settle";
    const importing = decision === "import" || settling;
    const keepLabel = posted?.kind === "paycheck" ? t.isRecordedPaycheck : t.isPostedCharge;
    const statusLabel = settling
      ? t.appliedUpcomingPayment
      : importing
        ? t.appliedImportAnyway
        : posted
          ? posted.kind === "paycheck"
            ? t.appliedRecordedPaycheck
            : t.appliedPostedCharge
          : t.appliedSkipped;
    const answerLabel = upcoming
      ? settling
        ? t.isDifferentCharge
        : t.isUpcomingPayment
      : posted
        ? importing
          ? keepLabel
          : t.isDifferentCharge
        : importing
          ? t.skipDuplicate
          : t.importAnyway;
    const answer = () =>
      onDecideAction([index], upcoming ? (settling ? "import" : "settle") : importing ? "skip" : "import");
    return { row, hit, posted, upcoming, settling, importing, statusLabel, answerLabel, answer };
  };

  // The note and what matched it. The table truncates the note to one line;
  // a card has the width of the screen and shows all of it.
  const matchNotes = (view: ReturnType<typeof rowView>, truncate = false) => (
    <>
      <span className={truncate ? "block truncate" : "block text-sm break-words"}>{view.row.note || "-"}</span>
      {view.hit?.kind === "imported" ? (
        <span className="block text-xs text-muted-foreground">{t.matchesExisting(view.hit.existingDate)}</span>
      ) : null}
      {view.posted ? (
        <PostedMatchNotice
          match={view.posted}
          incoming={{ amount: view.row.amount, currency }}
          showOutcome={view.upcoming ? view.settling : !view.importing}
          locale={locale}
        />
      ) : null}
    </>
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="import-review-duplicates-select-all"
            checked={allSelected}
            onCheckedChange={() => toggleAll()}
            aria-label={t.selectAllAria}
          />
          <Label
            htmlFor="import-review-duplicates-select-all"
            className="text-xs font-normal text-muted-foreground"
          >
            {t.selectedCount(selected.size)}
          </Label>
        </div>
        {selected.size > 0 ? (
          <>
            <Button type="button" variant="outline" size="xs" onClick={() => applyToSelected("import")}>
              {t.importAnyway}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => applyToSelected("skip")}>
              {t.skipDuplicate}
            </Button>
          </>
        ) : null}
      </div>

      {/* Below sm each row is a stacked card, like the Inbox's rows, with its
          answer at 44px: the table is 713px wide (fixed column widths plus a
          note that cannot shrink) and would sit in a 314px frame scrolling
          sideways. From sm the table stays. Both read the same row views, so
          the two presentations can never answer a row differently. */}
      <ul className="divide-y divide-border/50 rounded-md border border-border/50 sm:hidden">
        {rowIndexes.map((index) => {
          const view = rowView(index);
          return (
            <li key={index} data-duplicate-row={index} className="flex flex-col gap-2 p-3">
              <div className="flex items-start gap-3">
                <Checkbox
                  className="mt-0.5 after:-inset-3.5"
                  checked={selected.has(index)}
                  onCheckedChange={() => toggleRow(index)}
                  aria-label={t.selectRowAria}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="figure figure-sm text-xs text-muted-foreground">{toISODate(view.row.date)}</span>
                    <span className="figure text-sm">{formatMoney(view.row.amount, currency)}</span>
                  </div>
                  {matchNotes(view)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-2 pl-7 text-xs">
                <span className={view.importing ? "text-foreground" : "text-muted-foreground"}>{view.statusLabel}</span>
                <Button type="button" variant="ghost" size="xs" className="max-sm:h-11" onClick={view.answer}>
                  {view.answerLabel}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="overflow-x-auto rounded-md border border-border/50 max-sm:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead className="w-28">{common.date}</TableHead>
              <TableHead>{common.note}</TableHead>
              <TableHead className="w-32 text-right">{common.amount}</TableHead>
              <TableHead className="w-44">{t.reviewGroup}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rowIndexes.map((index) => {
              const view = rowView(index);
              return (
                <TableRow key={index}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(index)}
                      onCheckedChange={() => toggleRow(index)}
                      aria-label={t.selectRowAria}
                    />
                  </TableCell>
                  <TableCell className="figure figure-sm text-xs">{toISODate(view.row.date)}</TableCell>
                  <TableCell className="max-w-[22rem] text-sm">{matchNotes(view, true)}</TableCell>
                  <TableCell className="text-right">
                    <span className="figure text-sm">{formatMoney(view.row.amount, currency)}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={view.importing ? "text-foreground" : "text-muted-foreground"}>{view.statusLabel}</span>
                    <Button type="button" variant="ghost" size="xs" className="ml-1" onClick={view.answer}>
                      {view.answerLabel}
                    </Button>
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

/**
 * The "unusually large" bucket: spending rows well above their category's
 * typical amount (see src/lib/extraordinary.ts). Same shape as the duplicates
 * panel - pick rows, apply one verdict to them - but the verdict is
 * one-off-or-normal, and normal is the default: a row is only ever marked a
 * one-off because the user said so.
 */
function ExtraordinaryRowsPanel({
  rowIndexes,
  rows,
  hits,
  currency,
  locale,
  decisions,
  onDecideAction,
}: {
  rowIndexes: number[];
  rows: ReviewRow[];
  hits: Record<number, CsvExtraordinaryHit>;
  currency: string;
  locale: Locale;
  decisions: Record<number, "extraordinary" | "normal">;
  onDecideAction: (rowIndexes: number[], decision: "extraordinary" | "normal") => void;
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
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rowIndexes));
  const applyToSelected = (decision: "extraordinary" | "normal") => {
    if (selected.size === 0) return;
    onDecideAction(Array.from(selected), decision);
    setSelected(new Set());
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <Checkbox
            id="import-review-extraordinary-select-all"
            checked={allSelected}
            onCheckedChange={() => toggleAll()}
            aria-label={t.selectAllAria}
          />
          <Label
            htmlFor="import-review-extraordinary-select-all"
            className="text-xs font-normal text-muted-foreground"
          >
            {t.selectedCount(selected.size)}
          </Label>
        </div>
        {selected.size > 0 ? (
          <>
            <Button type="button" variant="outline" size="xs" onClick={() => applyToSelected("extraordinary")}>
              {t.markExtraordinary}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => applyToSelected("normal")}>
              {t.keepAsNormal}
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
              <TableHead className="w-44">{t.reviewGroup}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rowIndexes.map((index) => {
              const row = rows[index];
              const hit = hits[index];
              const marked = decisions[index] === "extraordinary";
              return (
                <TableRow key={index}>
                  <TableCell>
                    <Checkbox
                      checked={selected.has(index)}
                      onCheckedChange={() => toggleRow(index)}
                      aria-label={t.selectRowAria}
                    />
                  </TableCell>
                  <TableCell className="figure figure-sm text-xs">{toISODate(row.date)}</TableCell>
                  <TableCell className="max-w-[22rem] text-sm">
                    <span className="block truncate">{row.note || "-"}</span>
                    {hit ? (
                      <span className="block text-xs text-muted-foreground">
                        {t.typicalForCategory(hit.categoryName, formatMoney(hit.median, hit.medianCurrency))}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="figure text-sm">{formatMoney(row.amount, currency)}</span>
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={marked ? "text-foreground" : "text-muted-foreground"}>
                      {marked ? t.appliedExtraordinary : t.appliedNormal}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="ml-1"
                      onClick={() => onDecideAction([index], marked ? "normal" : "extraordinary")}
                    >
                      {marked ? t.keepAsNormal : t.markExtraordinary}
                    </Button>
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
            <TableCell className="figure figure-sm text-xs">{toISODate(row.date)}</TableCell>
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
