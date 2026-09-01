import { cn } from "@/lib/utils";

/**
 * One tick per day of the pay period: days spent are inked, today is the accent
 * marker, days left are hairlines. It is the app's recurring motif - the month
 * is two periods, and this is where you are in one.
 */
export function PeriodRail({
  totalDays,
  elapsed,
  className,
  compact = false,
}: {
  totalDays: number;
  /** Days already gone, so `elapsed` is the index of today. */
  elapsed: number;
  className?: string;
  compact?: boolean;
}) {
  const days = Array.from({ length: Math.max(1, totalDays) }, (_, index) => index);

  return (
    <div
      className={cn("flex items-end gap-[2px]", className)}
      aria-hidden="true"
    >
      {days.map((day) => {
        const isPast = day < elapsed;
        const isToday = day === elapsed;
        return (
          <span
            key={day}
            className={cn(
              "flex-1 rounded-[1px] transition-colors",
              compact ? "h-2" : "h-3.5",
              isToday
                ? "bg-primary"
                : isPast
                  ? "bg-foreground/35"
                  : "bg-foreground/12",
              isToday && !compact && "h-5",
            )}
          />
        );
      })}
    </div>
  );
}
