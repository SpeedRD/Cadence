import { FlaskConical } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The framing every "what-if" tool (Afford, the debt payoff comparator) uses
 * to signal that nothing on the page is applied or saved automatically. Pure
 * presentational: the caller supplies the finished, localized copy.
 */
export function ExploratoryBadge({ note, className }: { note: string; className?: string }) {
  return (
    <p className={cn("flex items-start gap-1.5 text-xs text-muted-foreground", className)}>
      <FlaskConical className="mt-0.5 size-3.5 shrink-0" />
      <span>{note}</span>
    </p>
  );
}
