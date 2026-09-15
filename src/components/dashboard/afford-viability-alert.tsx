import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  FROM_AFFORD_HREF,
  notViableAffordItems,
  summarizeAffordViability,
  type AffordTrackedItem,
} from "@/lib/afford-tracking";
import { formatMoney } from "@/lib/currency";
import type { Dictionary } from "@/lib/i18n";

/**
 * The plans recorded from Afford whose remaining payments no longer pass
 * Afford's two checks against today's projections - the room they were
 * confirmed against has been taken by commitments recorded since. Each
 * request re-checks every tracked plan (see recheckAffordItems), so this
 * clears itself the moment the room is back. Advisory, like Afford: nothing
 * is blocked or changed by it.
 */
export function AffordViabilityAlert({
  tracked,
  t,
}: {
  tracked: AffordTrackedItem[];
  t: Dictionary["dashboard"];
}) {
  const lines = notViableAffordItems(tracked).flatMap((item) => {
    const viability = summarizeAffordViability(item.verdict);
    if (viability.status !== "short") return [];
    return [
      {
        id: item.itemId,
        text: t.affordShortItem(
          item.name,
          formatMoney(viability.shortfall, viability.currency),
          viability.periodLabel,
        ),
      },
    ];
  });
  if (lines.length === 0) return null;

  return (
    <Alert className="border-[var(--warning)]/40">
      <AlertTitle>{t.affordShortTitle(lines.length)}</AlertTitle>
      <AlertDescription>
        <p>{t.affordShortDescription}</p>
        <ul className="list-disc space-y-0.5 pl-4">
          {lines.map((line) => (
            <li key={line.id}>{line.text}</li>
          ))}
        </ul>
        <Link
          href={FROM_AFFORD_HREF}
          className="underline underline-offset-3 hover:text-foreground"
        >
          {t.affordShortLink}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
