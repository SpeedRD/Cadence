import { cn } from "@/lib/utils";

/** Green under 70%, amber to 100%, red over budget. */
export function meterStatus(value: number, max: number) {
  if (max <= 0) return "neutral" as const;
  const share = value / max;
  if (share > 1) return "critical" as const;
  if (share >= 0.7) return "warning" as const;
  return "good" as const;
}

const STATUS_COLOR: Record<string, string> = {
  good: "var(--good)",
  warning: "var(--warning)",
  critical: "var(--critical)",
  neutral: "var(--muted-foreground)",
  accent: "var(--primary)",
};

export function Meter({
  value,
  max,
  status,
  className,
  size = "default",
}: {
  value: number;
  max: number;
  status?: keyof typeof STATUS_COLOR;
  className?: string;
  size?: "default" | "lg";
}) {
  const resolved = status ?? meterStatus(value, max);
  const share = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const overflow = max > 0 && value > max;

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-full bg-foreground/8",
        size === "lg" ? "h-2" : "h-1.5",
        className,
      )}
      role="presentation"
    >
      <div
        className="h-full rounded-full transition-[width] duration-300"
        style={{
          width: `${share * 100}%`,
          backgroundColor: STATUS_COLOR[resolved],
        }}
      />
      {overflow ? (
        <div
          className="absolute inset-y-0 right-0 w-1 rounded-full"
          style={{ backgroundColor: STATUS_COLOR.critical }}
        />
      ) : null}
    </div>
  );
}
