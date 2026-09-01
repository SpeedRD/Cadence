import { formatMoney } from "@/lib/currency";
import { cn } from "@/lib/utils";

type Tone = "default" | "positive" | "negative" | "muted";

const TONE_CLASS: Record<Tone, string> = {
  default: "",
  positive: "text-[var(--good)]",
  negative: "text-foreground",
  muted: "text-muted-foreground",
};

export function Money({
  amount,
  currency,
  tone = "default",
  prefix,
  className,
  maximumFractionDigits,
}: {
  amount: number;
  currency: string;
  tone?: Tone;
  prefix?: string;
  className?: string;
  maximumFractionDigits?: number;
}) {
  return (
    <span className={cn("figure", TONE_CLASS[tone], className)}>
      {prefix}
      {formatMoney(amount, currency, { maximumFractionDigits })}
    </span>
  );
}
