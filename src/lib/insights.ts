/**
 * The Insight Engine's pure half: the typed Insight, the registry of
 * detectors, and detectInsights() - the one function that runs them all.
 *
 * An insight is a *standing* signal: something the app has already noticed
 * that stays true until the user resolves it (a recurring item that cannot
 * post, an Afford plan that no longer fits, a charge pattern that looks like
 * an untracked bill, a goal whose confirmed plan is behind its roadmap, a
 * goal whose pace outruns the accounts' projected room before its target
 * date). The Inbox page lists every current one and the nav badge counts
 * them; each also keeps appearing where it always did (the Dashboard alerts,
 * the Recurring page's badges and "Looks recurring" card, the goal page's
 * roadmap note) - except the goal forecast, which Afford's projection
 * computes and only the Inbox shows. Point-in-time prompts - the check-in's
 * reconciliation warning, the one-off-expense question - are not insights
 * and never pass through here.
 *
 * Nothing here detects anything. Each detector re-presents a signal the app
 * already computes (see InsightContext for where each input comes from) as
 * the Insight shape; the thresholds, queries and rules live with the signals
 * themselves and are not repeated. src/lib/data/insights.ts loads the inputs
 * and strips dismissed insights. No I/O and no Prisma, so client components
 * can import the shapes; every data-layer import below is type-only.
 *
 * Adding a detector: write one `(context: InsightContext) => Insight[]`,
 * add its input to InsightContext (and to loadInsightContext in the data
 * layer), add its source to INSIGHT_SOURCES and its function to
 * INSIGHT_DETECTORS. Nothing else changes - not the Inbox, not the badge,
 * not the dismissal table.
 */
import {
  FROM_AFFORD_HREF,
  notViableAffordItems,
  summarizeAffordViability,
  type AffordTrackedItem,
} from "@/lib/afford-tracking";
import { formatDate, toISODate } from "@/lib/date";
import { summarizeGoalForecast, type GoalForecast } from "@/lib/goal-forecast";
import type { Dictionary } from "@/lib/i18n";
import { round2 } from "@/lib/money";
import type { RecurringSuggestion } from "@/lib/recurring-detection";
import type { RecurringPostingSummary, RecurringSkipReason } from "@/lib/recurring-posting";

import type { GoalRoadmapStatus } from "@/lib/data/payday";

/**
 * Every registered detector, by name. `source` is what InsightDismissal
 * stores beside the key, so a name here is permanent once released.
 */
export const INSIGHT_SOURCES = [
  "not_posting",
  "afford_viability",
  "recurring_suggestion",
  "goal_behind",
  "goal_forecast_risk",
] as const;
export type InsightSource = (typeof INSIGHT_SOURCES)[number];

export function isInsightSource(value: string): value is InsightSource {
  return (INSIGHT_SOURCES as readonly string[]).includes(value);
}

/**
 * The app's two existing severities, by their own names. "critical" is the
 * red `--critical` token: the nav badge's "needs attention", the Recurring
 * page's "Short by" badge, a buffer breach - money already committed is not
 * where the plan says it is. "advisory" is Afford's word for a check that
 * blocks and changes nothing (the `--warning` amber): worth a look, no more.
 */
export const INSIGHT_SEVERITIES = ["critical", "advisory"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

/** The figures that triggered an insight, as figures - the page formats them. */
export type InsightEvidence =
  | { kind: "money"; label: string; amount: number; currency: string }
  | { kind: "date"; label: string; date: string }
  | { kind: "text"; label: string; value: string };

/** What a dismissal is keyed by: the detector and the identity it gives the insight. */
export interface InsightRef {
  source: InsightSource;
  /** The same identity the signal's own surface uses for the row: a recurring item's id, `accountId:merchantKey`, a goal's id. */
  key: string;
}

export interface Insight extends InsightRef {
  /** `${source}:${key}` - unique across sources. */
  id: string;
  severity: InsightSeverity;
  title: string;
  evidence: InsightEvidence[];
  /** Where to go to resolve it. */
  actionHref: string;
  dismissible: boolean;
}

export function insightId(ref: InsightRef): string {
  return `${ref.source}:${ref.key}`;
}

/**
 * Everything the detectors read, already computed by each signal's own code:
 *   recurringPosting     this request's catch-up posting run (AppContext.recurringPosting)
 *   affordRechecks       the Afford tracker's re-check of every recorded plan (recheckAffordItems)
 *   recurringSuggestions the pattern detector's current suggestions (findRecurringSuggestions)
 *   goalRoadmaps         every goal's roadmap pace beside its confirmed plan (getGoalRoadmapStatuses)
 *   goalForecasts        every dated goal's walk to its target date through Afford's projection (forecastGoalFunding)
 * plus the dictionary the titles and labels are written in and the display
 * currency the roadmap figures are in.
 */
export interface InsightContext {
  dictionary: Dictionary;
  /** What the goal roadmap figures are in (AppContext.displayCurrency). */
  displayCurrency: string;
  recurringPosting: RecurringPostingSummary | null;
  affordRechecks: AffordTrackedItem[];
  recurringSuggestions: RecurringSuggestion[];
  goalRoadmaps: GoalRoadmapStatus[];
  goalForecasts: GoalForecast[];
}

export type InsightDetector = (context: InsightContext) => Insight[];

/**
 * The Dashboard's not-posting alert: the recurring items this request's
 * catch-up run could not process, skipped (no account, archived account, no
 * goal, goal already funded) or failed. Same list, same reasons, same
 * wording for the reason (NotPostingAlert's own strings).
 */
export const detectNotPosting: InsightDetector = ({ dictionary, recurringPosting }) => {
  if (!recurringPosting) return [];
  const t = dictionary.inbox;
  const reasons = dictionary.dashboard;
  const reasonText: Record<RecurringSkipReason, string> = {
    missing_account: reasons.notPostingReasonMissingAccount,
    missing_goal: reasons.notPostingReasonMissingGoal,
    missing_account_and_goal: reasons.notPostingReasonMissingAccountAndGoal,
    account_archived: reasons.notPostingReasonAccountArchived,
    goal_achieved: reasons.notPostingReasonGoalAchieved,
  };
  const insight = (id: string, name: string, evidence: InsightEvidence[]): Insight => ({
    id: insightId({ source: "not_posting", key: id }),
    source: "not_posting",
    key: id,
    severity: "critical",
    title: t.notPostingTitle(name),
    evidence,
    actionHref: "/recurring",
    dismissible: true,
  });
  return [
    ...recurringPosting.skipped.map((item) =>
      insight(item.id, item.name, [
        { kind: "text", label: t.notPostingReason, value: reasonText[item.reason] },
        { kind: "date", label: t.notPostingDue, date: item.nextDate },
        {
          kind: "text",
          label: t.notPostingKind,
          value:
            item.kind === "CONTRIBUTION" ? t.notPostingKindContribution : t.notPostingKindSubscription,
        },
      ]),
    ),
    ...recurringPosting.failed.map((item) =>
      insight(item.id, item.name, [
        {
          kind: "text",
          label: t.notPostingReason,
          value: `${reasons.notPostingReasonFailed}: ${item.error}`,
        },
      ]),
    ),
  ];
};

/**
 * The Dashboard's Afford-viability alert and the Recurring page's "Short by"
 * badge: every recorded plan whose remaining payments no longer pass Afford's
 * two checks, reduced to the first failing period exactly as
 * summarizeAffordViability reduces it for the badge.
 */
export const detectAffordViability: InsightDetector = ({ dictionary, affordRechecks }) => {
  const t = dictionary.inbox;
  return notViableAffordItems(affordRechecks).flatMap((item) => {
    const viability = summarizeAffordViability(item.verdict);
    if (viability.status !== "short") return [];
    const failing = item.verdict.failing[0];
    const check = failing.account.passes ? failing.flexible : failing.account;
    return [
      {
        id: insightId({ source: "afford_viability", key: item.itemId }),
        source: "afford_viability",
        key: item.itemId,
        severity: "critical",
        title: t.affordTitle(item.name),
        evidence: [
          { kind: "money", label: t.affordShortfall, amount: viability.shortfall, currency: viability.currency },
          { kind: "text", label: t.affordPeriod, value: viability.periodLabel },
          {
            kind: "money",
            label: t.affordInstallment,
            amount: failing.installmentTotal,
            currency: item.verdict.currency,
          },
          {
            kind: "money",
            label: t.affordHeadroom,
            amount: "headroomAfter" in check ? check.headroomAfter : check.availableAfter,
            currency: check.currency,
          },
          {
            kind: "text",
            label: t.affordCheck,
            value:
              viability.check === "account"
                ? t.affordCheckAccount(failing.account.name)
                : t.affordCheckFlexible,
          },
        ],
        actionHref: FROM_AFFORD_HREF,
        dismissible: true,
      } satisfies Insight,
    ];
  });
};

/**
 * The Recurring page's "Looks recurring" card: one insight per pattern the
 * detector currently suggests, keyed like the card's own rows (and like
 * RecurringSuggestionDismissal) by account + merchant key.
 */
export const detectRecurringSuggestions: InsightDetector = ({ dictionary, recurringSuggestions }) => {
  const t = dictionary.inbox;
  return recurringSuggestions.map((suggestion) => {
    const key = `${suggestion.accountId}:${suggestion.merchantKey}`;
    const first = suggestion.occurrences[0];
    const last = suggestion.occurrences[suggestion.occurrences.length - 1];
    return {
      id: insightId({ source: "recurring_suggestion", key }),
      source: "recurring_suggestion",
      key,
      severity: "advisory",
      title: t.suggestionTitle(suggestion.name),
      evidence: [
        { kind: "money", label: t.suggestionAmount, amount: suggestion.amount, currency: suggestion.currency },
        {
          kind: "text",
          label: t.suggestionCadence,
          value: dictionary.recurring.suggestionCadence(suggestion.cadence, suggestion.anchorDays),
        },
        {
          kind: "text",
          label: t.suggestionCharges,
          value: t.suggestionChargesValue(
            suggestion.occurrences.length,
            formatDate(first.date),
            formatDate(last.date),
          ),
        },
        { kind: "text", label: t.suggestionAccount, value: suggestion.accountName },
        ...suggestion.nextDates.map(
          (date): InsightEvidence => ({ kind: "date", label: t.suggestionNext, date: toISODate(date) }),
        ),
      ],
      actionHref: "/recurring",
      dismissible: true,
    } satisfies Insight;
  });
};

/**
 * The goal page's "behind the roadmap" note: a dated goal whose confirmed
 * plan for the plan period sets aside less than its roadmap pace - the same
 * `roadmapAmount - plannedAmount > 0.005` test, over the same status. An
 * undated goal has no roadmap to be behind (its figure is its whole
 * remaining balance), so it is never one of these. When the accounts' room
 * could not even cover the pace, that shortfall rides along as evidence,
 * as the page's own room-shortfall note does.
 */
export const detectGoalsBehind: InsightDetector = ({ dictionary, displayCurrency, goalRoadmaps }) => {
  const t = dictionary.inbox;
  return goalRoadmaps.flatMap((status) => {
    if (!status.targetDate || status.roadmapAmount === null || !status.planned) return [];
    const behind = round2(status.roadmapAmount - status.planned.plannedAmount);
    if (behind <= 0.005) return [];
    const roomShortfall = round2(status.roadmapAmount - status.planned.recommendedAmount);
    return [
      {
        id: insightId({ source: "goal_behind", key: status.goalId }),
        source: "goal_behind",
        key: status.goalId,
        severity: "advisory",
        title: t.goalTitle(status.name),
        evidence: [
          { kind: "money", label: t.goalBehindBy, amount: behind, currency: displayCurrency },
          { kind: "money", label: t.goalRoadmap, amount: status.roadmapAmount, currency: displayCurrency },
          {
            kind: "money",
            label: t.goalPlanned,
            amount: status.planned.plannedAmount,
            currency: displayCurrency,
          },
          { kind: "text", label: t.goalPeriod, value: status.period.label },
          { kind: "date", label: t.goalTarget, date: toISODate(status.targetDate) },
          ...(roomShortfall > 0.005
            ? [
                {
                  kind: "money",
                  label: t.goalRoomShortfall,
                  amount: roomShortfall,
                  currency: displayCurrency,
                } satisfies InsightEvidence,
              ]
            : []),
        ],
        actionHref: `/goals/${status.goalId}`,
        dismissible: true,
      } satisfies Insight,
    ];
  });
};

/**
 * Afford's projection walked to each dated goal's target date: the first
 * period ahead in which the accounts' projected room - income less scheduled
 * commitments less buffer, after the goals funded before it - could not give
 * the goal its pace, and by how much (planGoalFunding's own shortfall, the
 * figure Step 3 reports as "room couldn't cover", here for a period that has
 * not happened yet), reduced exactly as summarizeGoalForecast reduces it.
 * The evidence is Afford's kind: the shortfall and the period first, then
 * the pace asked, what the room could give, each account with room there and
 * the target date. Not the goal page's "behind the roadmap" note, which
 * measures what the plan period's confirmed check-in set aside
 * (detectGoalsBehind): this asks whether the periods ahead can keep the pace
 * up at all. A confirmed period is never in the walk, and an undated goal
 * has no target date to walk to (forecastGoalFunding leaves both out).
 * Advisory: nothing here is committed - the estimate is the discretionary
 * funding the user adjusts check-in to check-in.
 */
export const detectGoalForecastRisk: InsightDetector = ({ dictionary, goalForecasts }) => {
  const t = dictionary.inbox;
  return goalForecasts.flatMap((forecast) => {
    const summary = summarizeGoalForecast(forecast);
    if (summary.status !== "short") return [];
    const { period } = summary;
    const withRoom = period.draws.filter((draw) => draw.headroom > 0);
    return [
      {
        id: insightId({ source: "goal_forecast_risk", key: forecast.goalId }),
        source: "goal_forecast_risk",
        key: forecast.goalId,
        severity: "advisory",
        title: t.forecastTitle(forecast.name),
        evidence: [
          { kind: "money", label: t.forecastShortfall, amount: period.shortfall, currency: forecast.currency },
          { kind: "text", label: t.forecastPeriod, value: period.period.label },
          { kind: "money", label: t.forecastPace, amount: period.pace, currency: forecast.currency },
          { kind: "money", label: t.forecastRoom, amount: period.recommended, currency: forecast.currency },
          ...(withRoom.length > 0
            ? withRoom.map(
                (draw): InsightEvidence => ({
                  kind: "money",
                  label: t.forecastRoomOn(draw.name),
                  amount: draw.headroom,
                  currency: draw.currency,
                }),
              )
            : [{ kind: "text", label: t.forecastAccounts, value: t.forecastNoRoom } satisfies InsightEvidence]),
          { kind: "date", label: t.forecastTarget, date: toISODate(forecast.targetDate) },
        ],
        actionHref: `/goals/${forecast.goalId}`,
        dismissible: true,
      } satisfies Insight,
    ];
  });
};

/**
 * The registry. Order matters only within a severity: the Inbox lists
 * critical insights first, then advisory, each group in this order and then
 * in each detector's own order.
 */
export const INSIGHT_DETECTORS: readonly InsightDetector[] = [
  detectNotPosting,
  detectAffordViability,
  detectRecurringSuggestions,
  detectGoalsBehind,
  detectGoalForecastRisk,
];

const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, advisory: 1 };

/** Every current insight from every registered detector, critical first. Stable within a severity. */
export function detectInsights(context: InsightContext): Insight[] {
  const insights = INSIGHT_DETECTORS.flatMap((detect) => detect(context));
  return insights
    .map((insight, index) => ({ insight, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.insight.severity] - SEVERITY_RANK[b.insight.severity] || a.index - b.index,
    )
    .map(({ insight }) => insight);
}

/** `insights` without the ones in `dismissed` - what the Inbox shows and the nav badge counts. */
export function withoutDismissed(insights: Insight[], dismissed: InsightRef[]): Insight[] {
  const gone = new Set(dismissed.map(insightId));
  return insights.filter((insight) => !gone.has(insight.id));
}
