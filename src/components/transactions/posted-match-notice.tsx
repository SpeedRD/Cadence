import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/currency";
import { fromISODate } from "@/lib/date";
import { formatDate } from "@/lib/date-format";
import { getDictionary, type Locale } from "@/lib/i18n";

import type { PostedMatch, PostedMatchRow } from "@/lib/data/posted-duplicates";

/** The label a posted row goes by: its item's name, a paycheck's note, or - with neither - its kind. */
function labelOf(row: PostedMatchRow, t: ReturnType<typeof getDictionary>["transactions"]): string {
  return row.label ?? (row.kind === "paycheck" ? t.isRecordedPaycheck : t.isPostedCharge);
}

/** A posted row's date ("YYYY-MM-DD") as the app writes dates. */
function dateOf(row: PostedMatchRow, locale: Locale): string {
  const date = fromISODate(row.date);
  return date ? formatDate(date, locale) : row.date;
}

/**
 * What a row being brought in matched: the posted recurring charge or the
 * recorded paycheck, its date and amount, both accounts when the row is on
 * another account than the posted charge, the other candidates when the
 * look-alike guard could not choose, and - when `showOutcome` - what choosing
 * "It's the posted charge" does: the posted row's old and new amount, or both
 * amounts for a paycheck, which never changes. Shared by the CSV review, the
 * review queue and the transaction form's prompt so all three say the same.
 */
export function PostedMatchNotice({
  match,
  incoming,
  showOutcome,
  locale,
}: {
  match: PostedMatch;
  /** The row being brought in. */
  incoming: { amount: number; currency: string };
  showOutcome: boolean;
  locale: Locale;
}) {
  const t = getDictionary(locale).transactions;
  const posted = match.posted;
  const postedMoney = formatMoney(posted.amount, posted.currency);
  const incomingMoney = formatMoney(incoming.amount, incoming.currency);
  const differs =
    posted.currency !== incoming.currency || Math.round(posted.amount * 100) !== Math.round(incoming.amount * 100);

  return (
    <span className="block space-y-0.5 text-xs whitespace-normal text-muted-foreground">
      <span className="block">
        {match.possible ? (
          <Badge variant="outline" className="mr-1.5 align-middle">
            {t.postedMatchPossible}
          </Badge>
        ) : null}
        {match.kind === "paycheck"
          ? t.postedMatchPaycheck(dateOf(posted, locale), postedMoney)
          : match.kind === "upcoming"
            ? t.postedMatchUpcoming(labelOf(posted, t), dateOf(posted, locale), postedMoney)
            : t.postedMatchRecurring(labelOf(posted, t), dateOf(posted, locale), postedMoney)}
      </span>
      {match.entryAccountName ? (
        <span className="block">{t.postedMatchOtherAccount(posted.accountName, match.entryAccountName)}</span>
      ) : null}
      {match.ambiguous ? (
        <span className="block">
          {t.postedMatchOthers(
            match.others
              .map((row) => `${labelOf(row, t)} ${dateOf(row, locale)} ${formatMoney(row.amount, row.currency)}`)
              .join("; "),
          )}
        </span>
      ) : null}
      {showOutcome ? (
        match.kind === "upcoming" ? (
          <span className="block">{t.upcomingMatchOutcome}</span>
        ) : match.kind === "paycheck" ? (
          <span className="block">{t.postedMatchBothAmounts(postedMoney, incomingMoney)}</span>
        ) : match.rewrite?.accountId && match.entryAccountName ? (
          <span className="block">
            {t.postedMatchMovesAccount(posted.accountName, match.entryAccountName, formatMoney(match.rewrite.amount, match.rewrite.currency))}
          </span>
        ) : match.rewrite ? (
          <span className="block">
            {t.postedMatchUpdates(postedMoney, formatMoney(match.rewrite.amount, match.rewrite.currency))}
          </span>
        ) : differs ? (
          <span className="block">{t.postedMatchStaysAsIs}</span>
        ) : null
      ) : null}
    </span>
  );
}
