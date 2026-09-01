import { PiggyBank, Repeat } from "lucide-react";

import { formatMoney } from "@/lib/currency";
import { formatDayMonth, formatRelativeDays } from "@/lib/date";
import type { Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import type { UpcomingItem } from "@/lib/data/dashboard";

/**
 * Subscriptions and contributions both reduce safe-to-spend, so both appear
 * here - contributions are tinted so money going *into* something never reads
 * as another bill.
 */
export function UpcomingList({
  items,
  today,
  displayCurrency,
  t,
}: {
  items: UpcomingItem[];
  today: Date;
  displayCurrency: string;
  t: Dictionary["dashboard"];
}) {
  return (
    <ul className="divide-y divide-border/70">
      {items.map((item) => {
        const isContribution = item.kind === "CONTRIBUTION";
        const Icon = isContribution ? PiggyBank : Repeat;
        return (
          <li key={item.id} className="flex items-center gap-3 py-2.5 first:pt-0">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md",
                isContribution
                  ? "bg-primary/12 text-primary"
                  : "bg-foreground/6 text-muted-foreground",
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{item.name}</p>
              <p className="text-[0.6875rem] text-muted-foreground">
                {formatDayMonth(item.nextDate)} ·{" "}
                {formatRelativeDays(today, item.nextDate)}
                {isContribution ? t.contributionSuffix : ""}
              </p>
            </div>
            <div className="text-right">
              <p className="figure text-sm">
                {formatMoney(item.amount, displayCurrency)}
              </p>
              {item.currency !== displayCurrency ? (
                <p className="text-[0.6875rem] text-muted-foreground">
                  {formatMoney(item.nativeAmount, item.currency)}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
