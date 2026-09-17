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
};

/** Where the insight came from - the surface it still appears on. */
const SOURCE_LABEL: Record<InsightSource, (t: InboxDictionary) => string> = {
  not_posting: (t) => t.sourceNotPosting,
  afford_viability: (t) => t.sourceAffordViability,
  recurring_suggestion: (t) => t.sourceRecurringSuggestion,
  goal_behind: (t) => t.sourceGoalBehind,
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
            className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    insight.severity === "critical" ? "bg-[var(--critical)]" : "bg-[var(--warning)]",
                  )}
                />
                <span className="truncate">{insight.title}</span>
              </p>
              <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
                {insight.evidence.map((evidence, index) => (
                  <div key={`${evidence.label}-${index}`} className="flex gap-1">
                    <dt>{evidence.label}:</dt>
                    <dd className={evidence.kind === "money" ? "figure text-foreground" : "text-foreground"}>
                      {formatEvidence(evidence)}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-[0.6875rem] text-muted-foreground">{SOURCE_LABEL[insight.source](t)}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button asChild variant="outline" size="xs">
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
