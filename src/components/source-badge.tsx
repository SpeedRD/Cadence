import {
  CreditCard,
  FileSpreadsheet,
  Mail,
  PenLine,
  ArrowRightLeft,
  CircleSmall,
  Repeat,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { labelFor } from "@/lib/labels";
import { cn } from "@/lib/utils";

const SOURCE_ICONS: Record<string, LucideIcon> = {
  MANUAL: PenLine,
  CSV: FileSpreadsheet,
  GMAIL: Mail,
  OUTLOOK: Mail,
  PAYPAL: CreditCard,
  PAYDAY_CHECKIN: Wallet,
  RECURRING: Repeat,
};

/**
 * Renders any source value, including the ones Phase 2 will introduce, plus the
 * transfer marker that stands in for a source in the transactions list.
 */
export function SourceBadge({
  source,
  isTransfer = false,
  className,
  labels,
  transferLabel,
}: {
  source: string;
  isTransfer?: boolean;
  className?: string;
  labels: Record<string, string>;
  transferLabel: string;
}) {
  const Icon = isTransfer
    ? ArrowRightLeft
    : (SOURCE_ICONS[source] ?? CircleSmall);
  const label = isTransfer ? transferLabel : labelFor(labels, source);

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-foreground/6 px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground",
        className,
      )}
      title={
        isTransfer ? `${transferLabel} (${labelFor(labels, source)})` : label
      }
    >
      <Icon className="size-3" />
      {label}
    </span>
  );
}
