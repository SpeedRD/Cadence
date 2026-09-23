import { HandCoins, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/currency";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { ReimbursedExpenseRef, ReimbursementProgress } from "@/lib/shared-expense";

/**
 * How a row's shared-expense facts are shown, wherever rows are listed (the
 * Transactions table and an account's ledger): the badge naming the user's
 * own share of a shared expense, the badge on a deposit naming the expense it
 * pays back, and the running "recovered so far" line under a shared expense.
 * Presentational only - every figure arrives computed (see
 * src/lib/shared-expense.ts and loadReimbursementDetails).
 */

const BADGE_CLASS = "h-4 px-1.5 text-badge";

/** A shared expense: the amount shown is what left the account; this names the part that was the user's own. */
export function SharedExpenseBadge({
  yourShare,
  currency,
  locale,
}: {
  yourShare: number;
  currency: string;
  locale: Locale;
}) {
  const t = getDictionary(locale).transactions;
  return (
    <Badge variant="outline" className={BADGE_CLASS}>
      <Users className="size-2.5" />
      {t.sharedBadge} · {t.yourShareOf(formatMoney(yourShare, currency))}
    </Badge>
  );
}

/** A deposit paying back a shared expense - real income to the balance, never to an average - naming the expense. */
export function ReimbursementBadge({
  reimburses,
  locale,
}: {
  reimburses: ReimbursedExpenseRef;
  locale: Locale;
}) {
  const t = getDictionary(locale).transactions;
  return (
    <Badge variant="outline" className={BADGE_CLASS}>
      <HandCoins className="size-2.5" />
      {t.reimbursementOf(reimburses.note ?? reimburses.categoryName ?? t.uncategorized)}
    </Badge>
  );
}

/** How much of the rest has come back so far, re-summed from the linked deposits on every read. */
export function ReimbursementProgressLine({
  progress,
  currency,
  locale,
}: {
  progress: ReimbursementProgress;
  currency: string;
  locale: Locale;
}) {
  const t = getDictionary(locale).transactions;
  return (
    <span className="text-hint text-muted-foreground">
      {progress.settled
        ? t.fullyReimbursed(formatMoney(progress.owed, currency))
        : t.recoveredSoFar(
            formatMoney(progress.recovered, currency),
            formatMoney(progress.owed, currency),
            formatMoney(progress.pending, currency),
          )}
    </span>
  );
}
