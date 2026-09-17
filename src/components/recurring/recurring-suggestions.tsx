"use client";

import { ChevronDown, ChevronUp, Plus, X } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/lib/currency";
import { formatDate, toISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { RecurringSuggestion } from "@/lib/recurring-detection";
import {
  acceptRecurringSuggestionAction,
  dismissRecurringSuggestionAction,
} from "@/server/actions/recurring";

function suggestionKey(suggestion: RecurringSuggestion): string {
  return `${suggestion.accountId}:${suggestion.merchantKey}`;
}

/**
 * The "Looks recurring" list on the Recurring page: one row per pattern the
 * detector found (src/lib/recurring-detection.ts), with the charges behind
 * it a click away. Add and Dismiss send only the pattern's identity; the
 * server re-derives everything else, and the page re-renders without the
 * row once the action's revalidation lands.
 */
export function RecurringSuggestions({
  suggestions,
  displayCurrency,
  locale,
}: {
  suggestions: RecurringSuggestion[];
  displayCurrency: string;
  locale: Locale;
}) {
  const t = getDictionary(locale).recurring;
  const common = getDictionary(locale).common;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const run = (
    suggestion: RecurringSuggestion,
    action: typeof acceptRecurringSuggestionAction,
  ) => {
    const key = suggestionKey(suggestion);
    setBusyKey(key);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("accountId", suggestion.accountId);
      formData.set("merchantKey", suggestion.merchantKey);
      const result = await action(null, formData);
      if (result?.error) toast.error(result.error);
      else if (result?.message) toast.success(result.message);
      setBusyKey((current) => (current === key ? null : current));
    });
  };

  return (
    <ul className="divide-y divide-border/70">
      {suggestions.map((suggestion) => {
        const key = suggestionKey(suggestion);
        const busy = busyKey === key;
        const open = expanded.has(key);
        const first = suggestion.occurrences[0];
        const last = suggestion.occurrences[suggestion.occurrences.length - 1];
        return (
          <li key={key} className="space-y-2 py-3 first:pt-0 last:pb-0">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{suggestion.name}</p>
                <p className="text-[0.6875rem] text-muted-foreground">
                  {t.suggestionCadence(suggestion.cadence, suggestion.anchorDays)}
                  {` · ${suggestion.accountName}`}
                  {suggestion.categoryName ? ` · ${suggestion.categoryName}` : ""}
                </p>
                <p className="text-[0.6875rem] text-muted-foreground">
                  {t.suggestionEvidence(
                    suggestion.occurrences.length,
                    formatDate(first.date),
                    formatDate(last.date),
                  )}
                  {` · ${t.nextLabel} ${suggestion.nextDates.map(formatDate).join(", ")}`}
                </p>
              </div>
              <div className="text-right">
                <p className="figure text-sm">{formatMoney(suggestion.displayAmount, displayCurrency)}</p>
                {suggestion.currency !== displayCurrency ? (
                  <p className="figure figure-sm text-[0.6875rem] text-muted-foreground">
                    {formatMoney(suggestion.amount, suggestion.currency)}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="xs"
                disabled={busy}
                onClick={() => run(suggestion, acceptRecurringSuggestionAction)}
              >
                <Plus />
                {t.addAsRecurring}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={busy}
                title={t.dismissSuggestionHint}
                onClick={() => run(suggestion, dismissRecurringSuggestionAction)}
              >
                <X />
                {t.dismissSuggestion}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="ml-auto"
                aria-expanded={open}
                onClick={() => toggle(key)}
              >
                {open ? t.hideCharges : t.showCharges(suggestion.occurrences.length)}
                {open ? <ChevronUp /> : <ChevronDown />}
              </Button>
            </div>

            {open ? (
              <div className="overflow-x-auto rounded-md border border-border/50">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">{common.date}</TableHead>
                      <TableHead>{common.description}</TableHead>
                      <TableHead className="w-32 text-right">{common.amount}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {suggestion.occurrences.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="figure figure-sm text-xs">{toISODate(row.date)}</TableCell>
                        <TableCell className="max-w-[22rem] truncate text-sm">{row.note}</TableCell>
                        <TableCell className="text-right">
                          <span className="figure text-sm">{formatMoney(row.amount, suggestion.currency)}</span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
