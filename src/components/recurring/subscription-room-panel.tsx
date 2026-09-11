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
import { formatMoney } from "@/lib/currency";
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
          {t.roomDescription(threshold, room.period.label, room.historyPeriods)}
        </p>
        {room.occurrences > 1 ? (
          <p className="text-xs text-muted-foreground">
            {t.roomChargesTogether(room.occurrences, formatMoney(room.charge, room.currency))}
          </p>
        ) : null}
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.roomColumnAccount}</TableHead>
            <TableHead className="text-right whitespace-normal">
              {t.roomColumnHeadroom}
              <span className="block text-[0.625rem] font-normal text-muted-foreground">
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
              <TableCell>
                {account.name}
                {account.accountId === selectedAccountId ? (
                  <span className="ml-1.5 text-[0.625rem] text-muted-foreground">{t.roomSelected}</span>
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
              <TableCell>
                {account.passes ? (
                  <Badge variant="secondary" className="text-[var(--good)]">
                    {t.roomFits}
                  </Badge>
                ) : (
                  <Badge variant="destructive">{t.roomShort}</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

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
            <p className="text-[var(--critical)]">{t.roomNone(room.period.label)}</p>
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
