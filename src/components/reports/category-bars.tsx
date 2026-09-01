import { formatMoney } from "@/lib/currency";

import type { CategoryLine } from "@/lib/data/period-summary";

/**
 * Ranked horizontal bars. Every bar is directly labelled with its category and
 * amount, so colour is identity reinforcement rather than the only channel.
 */
export function CategoryBars({
  lines,
  currency,
  uncategorizedLabel,
}: {
  lines: CategoryLine[];
  currency: string;
  uncategorizedLabel: string;
}) {
  const max = lines.reduce((highest, line) => Math.max(highest, line.spent), 0);
  const total = lines.reduce((sum, line) => sum + line.spent, 0);

  return (
    <ul className="space-y-3">
      {lines.map((line) => {
        const share = max > 0 ? line.spent / max : 0;
        const percent = total > 0 ? Math.round((line.spent / total) * 100) : 0;
        return (
          <li key={line.categoryId ?? "none"} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: line.color }}
                />
                <span className="truncate">
                  {line.categoryId === null ? uncategorizedLabel : line.name}
                </span>
              </span>
              <span className="flex shrink-0 items-baseline gap-2">
                <span className="figure text-sm">
                  {formatMoney(line.spent, currency)}
                </span>
                <span className="text-xs text-muted-foreground tnum">
                  {percent}%
                </span>
              </span>
            </div>
            <div className="h-2 w-full rounded-[4px] bg-foreground/6">
              <div
                className="h-full rounded-[4px]"
                style={{
                  width: `${Math.max(share * 100, line.spent > 0 ? 2 : 0)}%`,
                  backgroundColor: line.color,
                }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
