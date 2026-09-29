/**
 * The Insight Engine's database half: loads what the detectors read - each
 * input through the signal's own existing computation, nothing re-derived
 * here - runs detectInsights() from src/lib/insights.ts, and strips the
 * insights the user dismissed. Dismissing writes the InsightDismissal row
 * that keeps an insight out of the Inbox and the nav badge, keyed by the
 * identity of the evidence it was made on (see InsightRef): the same
 * evidence stays hidden, a different period, reason or failure is a new
 * insight. Idempotent, and the row itself never expires (a recurring-
 * pattern suggestion, which has its own permanent table, keeps the same
 * permanent identity here).
 */
import { cache } from "react";

import type { AffordTrackedItem } from "@/lib/afford-tracking";
import { getSettings } from "@/lib/auth";
import { getDictionary } from "@/lib/i18n";
import {
  detectInsights,
  partitionDismissed,
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
    recurringPostingFailure: context.recurringPostingFailure ?? null,
    affordRechecks: tracked,
    recurringSuggestions,
    goalRoadmaps,
    goalForecasts,
  };
}

/** What the Inbox reads: the insights to list, and how many current ones a dismissal is hiding. */
export interface InsightState {
  insights: Insight[];
  dismissedCount: number;
}

/**
 * Every current, non-dismissed insight for `context`, critical first - what
 * the Inbox lists and the nav badge counts, so the two can never disagree -
 * with the number of current insights the dismissals are hiding (the empty
 * Inbox says so). Plain function (no requireAuth()/cookies()) so
 * scripts/verify-domain.ts can drive it the same way the page does.
 */
export async function collectInsightState(
  context: AffordContext,
  affordRechecks?: AffordTrackedItem[],
): Promise<InsightState> {
  const [insightContext, dismissed] = await Promise.all([
    loadInsightContext(context, affordRechecks),
    listInsightDismissals(),
  ]);
  const { visible, hidden } = partitionDismissed(detectInsights(insightContext), dismissed);
  return { insights: visible, dismissedCount: hidden.length };
}

/** The listed insights alone: what the nav badge counts. */
export async function collectInsights(
  context: AffordContext,
  affordRechecks?: AffordTrackedItem[],
): Promise<Insight[]> {
  return (await collectInsightState(context, affordRechecks)).insights;
}

/**
 * The insights as a page sees them: the request's own context plus the
 * buffer settings the Afford re-check needs, computed once per request
 * however many places read it (the nav badge on every page, the Inbox) and
 * never kept beyond it.
 */
export const getInsightState = cache(async (): Promise<InsightState> => {
  const [context, settings, affordRechecks] = await Promise.all([
    getAppContext(),
    getSettings(),
    getAffordRechecks(),
  ]);
  return collectInsightState(
    {
      ...context,
      bufferPercent: settings.bufferPercent,
      bufferFloorAmount: num(settings.bufferFloorAmount),
      bufferFloorCurrency: settings.bufferFloorCurrency,
    },
    affordRechecks,
  );
});

/** The current, non-dismissed insights, from the request's one run. */
export const getInsights = cache(async (): Promise<Insight[]> => (await getInsightState()).insights);

/**
 * Stop showing this insight - this evidence only: the key names the period,
 * reason or failure it was made on, so a different one is a new insight.
 * Idempotent: dismissing something already dismissed keeps the one row and
 * its original time. Nothing about the signal itself changes - the Dashboard
 * alert, the Recurring badge or the goal page's note still show it until it
 * is actually resolved.
 */
export async function dismissInsight(ref: InsightRef): Promise<void> {
  await prisma.insightDismissal.upsert({
    where: { source_key: { source: ref.source, key: ref.key } },
    create: { source: ref.source, key: ref.key },
    update: {},
  });
}
