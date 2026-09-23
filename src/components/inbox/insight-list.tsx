"use client";

import { ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/currency";
import { formatDate, fromISODate } from "@/lib/date";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { Insight, InsightEvidence, InsightSource } from "@/lib/insights";
import { cn } from "@/lib/utils";
import { dismissInsightAction } from "@/server/actions/insights";

type InboxDictionary = ReturnType<typeof getDictionary>["inbox"];

/** Which surface each source's link opens, in the Inbox's words. */
const OPEN_LABEL: Record<InsightSource, (t: InboxDictionary) => string> = {
  not_posting: (t) => t.openRecurring,
  afford_viability: (t) => t.openFromAfford,
  recurring_suggestion: (t) => t.openSuggestion,
  goal_behind: (t) => t.openGoal,
  goal_forecast_risk: (t) => t.openGoal,
};

/** Where the insight came from - the surface it still appears on (the goal forecast has no other: Afford's projection computes it for the Inbox alone). */
const SOURCE_LABEL: Record<InsightSource, (t: InboxDictionary) => string> = {
  not_posting: (t) => t.sourceNotPosting,
  afford_viability: (t) => t.sourceAffordViability,
  recurring_suggestion: (t) => t.sourceRecurringSuggestion,
  goal_behind: (t) => t.sourceGoalBehind,
  goal_forecast_risk: (t) => t.sourceGoalForecast,
};

function formatEvidence(evidence: InsightEvidence): string {
  switch (evidence.kind) {
    case "money":
      return formatMoney(evidence.amount, evidence.currency);
    case "date": {
      const date = fromISODate(evidence.date);
      return date ? formatDate(date) : evidence.date;
    }
    case "text":
      return evidence.value;
  }
}

/**
 * The Inbox's rows: one per insight, each with the figures that triggered
 * it, a link to the surface that can resolve it, and Dismiss. Dismiss sends
 * only the insight's identity; the page re-renders without the row once the
 * action's revalidation lands - the same shape as the Recurring page's
 * suggestion rows.
 */
export function InsightList({ insights, locale }: { insights: Insight[]; locale: Locale }) {
  const t = getDictionary(locale).inbox;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const dismiss = (insight: Insight) => {
    setBusyId(insight.id);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("source", insight.source);
      formData.set("key", insight.key);
      const result = await dismissInsightAction(null, formData);
      if (result?.error) toast.error(result.error);
      else if (result?.message) toast.success(result.message);
      setBusyId((current) => (current === insight.id ? null : current));
    });
  };

  return (
    <ul className="divide-y divide-border/70">
      {insights.map((insight) => {
        const busy = busyId === insight.id;
        return (
          <li
            key={insight.id}
            data-insight-id={insight.id}
            data-severity={insight.severity}
            className="flex flex-col gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0 max-sm:relative sm:flex-row sm:flex-wrap sm:items-start"
          >
            {/* On a phone the whole row opens the insight's surface: this
                link covers the row and only the two buttons sit above it, so
                Dismiss (even while disabled) stays its own control. Open
                remains the named link for assistive tech, so this one is
                hidden from it. */}
            <Link href={insight.actionHref} aria-hidden tabIndex={-1} className="absolute inset-0 sm:hidden" />
            <div className="min-w-0 flex-1 space-y-1">
              {/* Below sm the title wraps in full rather than truncating, and
                  the dot sits on its first line (1.75 = half of text-sm's 20px
                  line box less half the 6px dot). */}
              <p className="flex items-center gap-2 text-sm font-medium max-sm:items-start">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full max-sm:mt-1.75",
                    insight.severity === "critical" ? "bg-[var(--critical)]" : "bg-[var(--warning)]",
                  )}
                />
                <span className="truncate max-sm:break-words max-sm:whitespace-normal">{insight.title}</span>
              </p>
              <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-hint text-muted-foreground max-sm:grid max-sm:grid-cols-[auto_1fr] max-sm:gap-x-2">
                {insight.evidence.map((evidence, index) => (
                  <div key={`${evidence.label}-${index}`} className="flex gap-1 max-sm:contents">
                    <dt>{evidence.label}:</dt>
                    <dd className={evidence.kind === "money" ? "figure text-foreground" : "text-foreground"}>
                      {formatEvidence(evidence)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-hint text-muted-foreground">{SOURCE_LABEL[insight.source](t)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1 max-sm:flex-wrap">
              <Button asChild variant="outline" size="xs" className="max-sm:relative max-sm:h-11">
                <Link href={insight.actionHref}>
                  {OPEN_LABEL[insight.source](t)}
                  <ArrowUpRight />
                </Link>
              </Button>
              {insight.dismissible ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="max-sm:relative max-sm:h-11 max-sm:disabled:pointer-events-auto"
                  disabled={busy}
                  title={t.dismissHint}
                  onClick={() => dismiss(insight)}
                >
                  <X />
                  {t.dismiss}
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
