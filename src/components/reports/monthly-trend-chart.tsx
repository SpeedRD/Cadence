import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";

import type { MonthlyBreakdown } from "@/lib/data/monthly";
import type { Dictionary } from "@/lib/i18n";

/**
 * Same visual pattern as TrendChart (src/components/reports/trend-chart.tsx),
 * one bar per completed calendar month instead of per pay period, sized to
 * normal spending (lifestyle + committed) - savings/investing is shown in the
 * tooltip but deliberately excluded from the bar height, since it isn't
 * lifestyle overspending.
 */
export function MonthlyTrendChart({
  months,
  currency,
  t,
}: {
  months: MonthlyBreakdown[];
  currency: string;
  t: Dictionary["reports"];
}) {
  const max = months.reduce((highest, month) => Math.max(highest, month.normalSpending), 0);
  const scale = max > 0 ? max : 1;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span className="figure figure-sm">{formatMoney(max, currency)}</span>
        <span>{t.monthlyPeakLabel}</span>
      </div>

      <div className="flex h-44 items-end gap-2 border-b border-border/70 pb-0">
        {months.map((month) => {
          const height = (month.normalSpending / scale) * 100;
          return (
            <div
              key={month.window.key}
              className="group relative flex h-full flex-1 flex-col justify-end"
              tabIndex={0}
              aria-label={`${month.window.longLabel}: ${t.monthlyTooltipNormal(formatMoney(month.normalSpending, currency))}`}
            >
              {/* Capped and edge-anchored, same reasoning as TrendChart's tooltip. */}
              <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-44 -translate-x-1/2 rounded-md bg-popover px-2 py-1.5 text-xs opacity-0 shadow-md ring-1 ring-foreground/10 transition-opacity group-first:left-0 group-first:translate-x-0 group-last:right-0 group-last:left-auto group-last:translate-x-0 group-hover:opacity-100 group-focus:opacity-100 sm:max-w-56">
                <p className="font-medium">{month.window.label}</p>
                <p className="figure figure-sm text-muted-foreground">
                  {t.monthlyTooltipNormal(formatMoney(month.normalSpending, currency))}
                </p>
                <p className="figure figure-sm text-muted-foreground">
                  {t.monthlyTooltipSavings(formatMoney(month.savingsInvesting, currency))}
                </p>
              </div>
              <div
                className={cn("w-full rounded-t-[4px] bg-foreground/25 transition-colors group-hover:bg-foreground/40")}
                style={{ height: `${Math.max(height, month.normalSpending > 0 ? 1.5 : 0)}%` }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        {months.map((month) => (
          <div key={month.window.key} className="flex-1 text-center text-[0.6875rem] text-muted-foreground">
            {month.window.label}
          </div>
        ))}
      </div>
    </div>
  );
}
