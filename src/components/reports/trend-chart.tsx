import { formatMoney, formatMoneyCompact } from "@/lib/currency";
import { formatDayMonth } from "@/lib/date";
import { cn } from "@/lib/utils";

import type { TrendPoint } from "@/lib/data/reports";
import type { Dictionary } from "@/lib/i18n";

/**
 * Spending across the last six pay periods. One series, so no legend; the
 * exact figures live in the hover/focus tooltip and the axis maximum.
 *
 * A phone has no hover, so there each bar also prints its whole-unit figure
 * above itself, and the axis names each period by its start day ("Aug 16")
 * because "Aug 16-31" wraps in a 45px column.
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
  // A currency code comes back as "DOP 121,329" - the no-break space is where
  // it goes onto its own line, since the whole string is twice a column wide.
  const barFigures = points.map((point) => formatMoneyCompact(point.spent, currency).split("\u00a0"));
  const figureLines = Math.max(1, ...barFigures.map((parts) => parts.length));

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span className="figure figure-sm">{formatMoney(max, currency)}</span>
        <span>{t.peakPeriod}</span>
      </div>

      {/* The margin, not padding, clears the tallest bar's figure (a 12px
          line and mb-1 per line, plus 4px): padding would come out of h-44
          and shorten every bar. It collapses with space-y-3, so it is the
          whole gap, not an addition to it. */}
      <div
        className={cn(
          "flex h-44 items-end gap-2 border-b border-border/70 pb-0",
          figureLines > 1 ? "max-sm:mt-8" : "max-sm:mt-5",
        )}
      >
        {points.map((point, index) => {
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
                  "relative w-full rounded-t-[4px] transition-colors",
                  isCurrent
                    ? "bg-primary"
                    : "bg-foreground/25 group-hover:bg-foreground/40",
                )}
                style={{ height: `${Math.max(height, point.spent > 0 ? 1.5 : 0)}%` }}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "figure figure-sm absolute bottom-full left-1/2 mb-1 -translate-x-1/2 text-center text-xs leading-none whitespace-nowrap sm:hidden",
                    isCurrent ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {barFigures[index].map((part) => (
                    <span key={part} className="block">
                      {part}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        {points.map((point) => (
          <div
            key={point.period.key}
            className={cn(
              "flex-1 text-center text-hint",
              point.period.key === currentKey
                ? "text-foreground"
                : "text-muted-foreground",
            )}
          >
            <span className="sm:hidden">{formatDayMonth(point.period.start)}</span>
            <span className="max-sm:hidden">{point.period.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
