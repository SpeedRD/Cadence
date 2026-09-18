/**
 * The Insight Engine's database half: loads what the detectors read - each
 * input through the signal's own existing computation, nothing re-derived
 * here - runs detectInsights() from src/lib/insights.ts, and strips the
 * insights the user dismissed. Dismissing writes the InsightDismissal row
 * that keeps an insight out of the Inbox and the nav badge for good, the
 * same way RecurringSuggestionDismissal keeps a pattern off the Recurring
 * page: keyed by identity, idempotent, never expiring.
 */
import { cache } from "react";

import type { AffordTrackedItem } from "@/lib/afford-tracking";
import { getSettings } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n";
import {
  detectInsights,
  withoutDismissed,
  type Insight,
  type InsightContext,
  type InsightRef,
} from "@/lib/insights";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";

import { getAffordRechecks, recheckAffordItems, type AffordContext } from "@/lib/data/afford";
import { getAppContext } from "@/lib/data/context";
import { forecastGoalFunding } from "@/lib/data/goal-forecast";
import { getGoalRoadmapStatuses } from "@/lib/data/payday";
import { findRecurringSuggestions } from "@/lib/data/recurring-suggestions";

/** Every dismissal on record, as the refs withoutDismissed() takes. */
export async function listInsightDismissals(): Promise<InsightRef[]> {
  const rows = await prisma.insightDismissal.findMany({ select: { source: true, key: true } });
  // The column is a plain string (see the schema); rows written by a source
  // since removed from INSIGHT_SOURCES never match anything and are harmless.
  return rows as InsightRef[];
}

/**
 * The detectors' inputs for `context`, each from the function that already
 * computes the signal. `affordRechecks` may be passed in when the caller has
 * the tracker's run already (the request path does: getAffordRechecks is
 * request-cached and every page reads it) so the plans are not projected a
 * second time; otherwise the tracker runs here.
 */
export async function loadInsightContext(
  context: AffordContext,
  affordRechecks?: AffordTrackedItem[],
): Promise<InsightContext> {
  const [tracked, recurringSuggestions, goalRoadmaps, goalForecasts] = await Promise.all([
    affordRechecks ?? recheckAffordItems(context),
    findRecurringSuggestions(context),
    getGoalRoadmapStatuses(context),
    forecastGoalFunding(context),
  ]);
  return {
    dictionary: getDictionary(context.language),
    displayCurrency: context.displayCurrency,
    recurringPosting: context.recurringPosting ?? null,
    affordRechecks: tracked,
    recurringSuggestions,
    goalRoadmaps,
    goalForecasts,
  };
}

/**
 * Every current, non-dismissed insight for `context`, critical first - what
 * the Inbox lists and the nav badge counts, so the two can never disagree.
 * Plain function (no requireAuth()/cookies()) so scripts/verify-domain.ts
 * can drive it the same way the page does.
 */
export async function collectInsights(
  context: AffordContext,
  affordRechecks?: AffordTrackedItem[],
): Promise<Insight[]> {
  const [insightContext, dismissed] = await Promise.all([
    loadInsightContext(context, affordRechecks),
    listInsightDismissals(),
  ]);
  return withoutDismissed(detectInsights(insightContext), dismissed);
}

/**
 * The insights as a page sees them: the request's own context plus the
 * buffer settings the Afford re-check needs, computed once per request
 * however many places read it (the nav badge on every page, the Inbox) and
 * never kept beyond it.
 */
export const getInsights = cache(async (): Promise<Insight[]> => {
  const [context, settings, affordRechecks] = await Promise.all([
    getAppContext(),
    getSettings(),
    getAffordRechecks(),
  ]);
  return collectInsights(
    {
      ...context,
      bufferPercent: settings.bufferPercent,
      bufferFloorAmount: num(settings.bufferFloorAmount),
      bufferFloorCurrency: settings.bufferFloorCurrency,
    },
    affordRechecks,
  );
});

/**
 * Never show this insight again. Idempotent: dismissing something already
 * dismissed keeps the one row and its original time. Nothing about the
 * signal itself changes - the Dashboard alert, the Recurring badge or the
 * goal page's note still show it until it is actually resolved.
 */
export async function dismissInsight(ref: InsightRef): Promise<void> {
  await prisma.insightDismissal.upsert({
    where: { source_key: { source: ref.source, key: ref.key } },
    create: { source: ref.source, key: ref.key },
    update: {},
  });
}
