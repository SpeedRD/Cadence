import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";

import type { TrendPoint } from "@/lib/data/reports";
import type { Dictionary } from "@/lib/i18n";

/**
 * Spending across the last six pay periods. One series, so no legend; the
 * exact figures live in the hover/focus tooltip and the axis maximum.
 */
export function TrendChart({
  points,
  currency,
  currentKey,
  t,
}: {
  points: TrendPoint[];
  currency: string;
  currentKey: string;
  t: Dictionary["reports"];
}) {
  const max = points.reduce((highest, point) => Math.max(highest, point.spent), 0);
  const scale = max > 0 ? max : 1;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span className="figure figure-sm">{formatMoney(max, currency)}</span>
        <span>{t.peakPeriod}</span>
      </div>

      <div className="flex h-44 items-end gap-2 border-b border-border/70 pb-0">
        {points.map((point) => {
          const height = (point.spent / scale) * 100;
          const isCurrent = point.period.key === currentKey;
          return (
            <div
              key={point.period.key}
              className="group relative flex h-full flex-1 flex-col justify-end"
              tabIndex={0}
              aria-label={`${point.period.longLabel}: ${t.tooltipOut(formatMoney(point.spent, currency))}`}
            >
              {/* Capped and edge-anchored: a centred w-max tooltip on the first
                  or last bar reaches past the card, which clips it (Card is
                  overflow-hidden). The end bars anchor to their own edge
                  instead, and the cap keeps the middle ones inside on a phone. */}
              <div
                className={cn(
                  "pointer-events-none absolute bottom-full left-1/2 z-10 mb-2 w-max max-w-44 -translate-x-1/2 rounded-md bg-popover px-2 py-1.5 text-xs opacity-0 shadow-md ring-1 ring-foreground/10 transition-opacity group-hover:opacity-100 group-focus:opacity-100 sm:max-w-56",
                  "group-first:left-0 group-first:translate-x-0 group-last:right-0 group-last:left-auto group-last:translate-x-0",
                )}
              >
                <p className="font-medium">{point.period.label}</p>
                <p className="figure figure-sm text-muted-foreground">
                  {t.tooltipOut(formatMoney(point.spent, currency))}
                </p>
                <p className="figure figure-sm text-muted-foreground">
                  {t.tooltipIn(formatMoney(point.income, currency))}
                </p>
              </div>
              <div
                className={cn(
                  "w-full rounded-t-[4px] transition-colors",
                  isCurrent
                    ? "bg-primary"
                    : "bg-foreground/25 group-hover:bg-foreground/40",
                )}
                style={{ height: `${Math.max(height, point.spent > 0 ? 1.5 : 0)}%` }}
              />
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        {points.map((point) => (
          <div
            key={point.period.key}
            className={cn(
              "flex-1 text-center text-[0.6875rem]",
              point.period.key === currentKey
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            {point.period.label}
          </div>
        ))}
      </div>
    </div>
  );
}
