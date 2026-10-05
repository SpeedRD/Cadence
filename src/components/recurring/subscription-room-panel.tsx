"use client";

import { BeforeAfter } from "@/components/afford/afford-results";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { MIN_INCOME_HISTORY_PERIODS } from "@/lib/afford";
import { formatMoney } from "@/lib/currency";
import { formatPeriodShort } from "@/lib/date-format";
import { getDictionary, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import type { SubscriptionRoom } from "@/lib/data/subscription-room";

type LargeRoom = Extract<SubscriptionRoom, { large: true }>;

/**
 * The Recurring form's advisory panel for a large subscription: Afford's
 * per-account room table, one row per active account for the period the
 * "Next due" date lands in, and a recommendation. Advice only - it sits
 * between the fields and never touches the submit button.
 */
export function SubscriptionRoomPanel({
  room,
  selectedAccountId,
  threshold,
  locale,
}: {
  room: LargeRoom;
  /** The account currently picked in the form, so its row is marked and its own verdict spelled out. */
  selectedAccountId: string;
  /** The threshold, already formatted, for the explanation. */
  threshold: string;
  locale: Locale;
}) {
  const t = getDictionary(locale).recurring;
  const recommended = room.accounts.find((account) => account.accountId === room.recommendedAccountId) ?? null;
  const fitting = room.accounts.filter((account) => account.passes);
  const selected = room.accounts.find((account) => account.accountId === selectedAccountId) ?? null;
  const withoutHistory = room.accounts.filter((account) => account.basis === "none");
  const verdictBadge = (account: LargeRoom["accounts"][number]) =>
    account.passes ? (
      <Badge variant="secondary" className="text-[var(--good)]">
        {t.roomFits}
      </Badge>
    ) : (
      <Badge variant="destructive">{t.roomShort}</Badge>
    );

  return (
    <div
      className={cn(
        "reveal-block space-y-3 rounded-lg border px-3 py-2.5 text-sm",
        recommended ? "border-[var(--good)]/40" : "border-[var(--critical)]/40",
      )}
      role="status"
    >
      <div className="space-y-1">
        <p className="font-medium">{t.roomHeading}</p>
        <p className="text-xs text-muted-foreground">
          {t.roomDescription(threshold, formatPeriodShort(room.period, locale), room.incomePeriods)}
        </p>
        {room.incomePeriods > 0 && room.incomePeriods < MIN_INCOME_HISTORY_PERIODS ? (
          <p className="text-xs text-[var(--warning)]">{t.roomLowHistory(room.incomePeriods)}</p>
        ) : null}
        {room.occurrences > 1 ? (
          <p className="text-xs text-muted-foreground">
            {t.roomChargesTogether(room.occurrences, formatMoney(room.charge, room.currency))}
          </p>
        ) : null}
      </div>

      {/* Below sm each account is a stacked block, like the CSV duplicates
          review's rows: the table needs 347px (a nowrap name, the two
          figures and the badge) in the dialog's 317px, and its last column,
          the verdict, sat past the edge of a sideways scroll. From sm the
          table stays. Both read the same rows. */}
      <ul className="divide-y divide-border/50 overflow-hidden rounded-md border border-border/50 sm:hidden">
        {room.accounts.map((account) => (
          <li
            key={account.accountId}
            className={cn(
              "flex flex-col gap-1.5 px-3 py-2.5",
              account.accountId === room.recommendedAccountId && "bg-[var(--good)]/5",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0">
                {account.name}
                {account.accountId === selectedAccountId ? (
                  <span className="ml-1.5 text-badge text-muted-foreground">{t.roomSelected}</span>
                ) : null}
              </span>
              {verdictBadge(account)}
            </div>
            <div className="flex items-end justify-between gap-3">
              <span className="text-hint text-muted-foreground">
                {t.roomColumnHeadroom} · {t.roomBeforeAfter}
              </span>
              <BeforeAfter
                before={account.headroomBefore}
                after={account.headroomAfter}
                currency={account.currency}
                passes={account.passes}
              />
            </div>
          </li>
        ))}
      </ul>

      <div className="max-sm:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.roomColumnAccount}</TableHead>
              <TableHead className="text-right whitespace-normal">
                {t.roomColumnHeadroom}
                <span className="block text-badge font-normal text-muted-foreground">
                  {t.roomBeforeAfter}
                </span>
              </TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {room.accounts.map((account) => (
              <TableRow
                key={account.accountId}
                className={cn(account.accountId === room.recommendedAccountId && "bg-[var(--good)]/5")}
              >
                <TableCell className="whitespace-normal">
                  {account.name}
                  {account.accountId === selectedAccountId ? (
                    <span className="ml-1.5 text-badge text-muted-foreground">{t.roomSelected}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  <BeforeAfter
                    before={account.headroomBefore}
                    after={account.headroomAfter}
                    currency={account.currency}
                    passes={account.passes}
                  />
                </TableCell>
                <TableCell>{verdictBadge(account)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="space-y-1 text-xs">
        {recommended ? (
          <>
            <p className="text-[var(--good)]">
              {fitting.length > 1
                ? t.roomRecommendMost(
                    recommended.name,
                    formatMoney(recommended.headroomAfter, recommended.currency),
                    fitting.length,
                  )
                : t.roomRecommendOnly(
                    recommended.name,
                    formatMoney(recommended.headroomAfter, recommended.currency),
                  )}
            </p>
            {selected && selected.accountId !== recommended.accountId ? (
              <p className={selected.passes ? "text-muted-foreground" : "text-[var(--warning)]"}>
                {selected.passes
                  ? t.roomSelectedFits(selected.name)
                  : t.roomSelectedShort(selected.name, formatMoney(selected.shortfall, selected.currency))}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-[var(--critical)]">{t.roomNone(formatPeriodShort(room.period, locale))}</p>
            <p className="text-muted-foreground">{t.roomNoneSuggestion}</p>
          </>
        )}
        {withoutHistory.map((account) => (
          <p key={account.accountId} className="text-[var(--warning)]">
            {t.roomNoHistory(account.name)}
          </p>
        ))}
      </div>
    </div>
  );
}
