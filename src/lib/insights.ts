/**
 * The Insight Engine's pure half: the typed Insight, the registry of
 * detectors, and detectInsights() - the one function that runs them all.
 *
 * An insight is a *standing* signal: something the app has already noticed
 * that stays true until the user resolves it (a recurring item that cannot
 * post, an Afford plan that no longer fits, a charge pattern that looks like
 * an untracked bill, a goal whose confirmed plan is behind its roadmap or was
 * not carried out, a goal whose pace outruns the accounts' projected room
 * before its target date). The Inbox page lists every current one and the nav badge counts
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
import { toISODate } from "@/lib/date";
import { formatDate, formatPeriodShort } from "@/lib/date-format";
import { summarizeGoalForecast, type GoalForecast } from "@/lib/goal-forecast";
import type { Dictionary, Locale } from "@/lib/i18n";
import type { RecurringSuggestion } from "@/lib/recurring-detection";
import type { PostingSkipReason, RecurringPostingSummary } from "@/lib/recurring-posting";

import type { RecurringPostingFailure } from "@/lib/data/context";
import type { GoalRoadmapStatus } from "@/lib/data/payday";

/**
 * Every registered detector, by name. `source` is what InsightDismissal
 * stores beside the key, so a name here is permanent once released.
 */
export const INSIGHT_SOURCES = [
  "not_posting",
  "posting_run_failed",
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
 * red `--critical` token: the Inbox's "Needs attention" group, a buffer
 * breach - money already committed is not where the plan says it is (the
 * nav badge counts every insight and says "to review", not "needs
 * attention"). "advisory" is Afford's word for a check that blocks and
 * changes nothing (the `--warning` amber): worth a look, no more - a plan
 * that would stop fitting in a period ahead is one, since nothing has gone
 * wrong yet.
 */
export const INSIGHT_SEVERITIES = ["critical", "advisory"] as const;
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

/** The figures that triggered an insight, as figures - the page formats them. */
export type InsightEvidence =
  | { kind: "money"; label: string; amount: number; currency: string }
  | { kind: "date"; label: string; date: string }
  | { kind: "text"; label: string; value: string };

/**
 * What a dismissal is keyed by: the detector and the identity of the
 * evidence it was made on, so a dismissal hides that evidence and nothing
 * later. The thing the signal's own surface keys its row by (a recurring
 * item's id, a goal's id, `accountId:merchantKey`), plus what makes this
 * instance of it different from the next:
 *   not_posting          `${itemId}:${reason}` - the skip reason, or `failed`
 *   afford_viability     `${itemId}:${periodKey}` - the first failing period
 *   goal_behind          `${goalId}:${periodKey}:plan` or `:contributed` - the period and the statement
 *   goal_forecast_risk   `${goalId}:${periodKey}` - the first short period
 *   recurring_suggestion `${accountId}:${merchantKey}` - permanent, like its own table
 *   posting_run_failed   `run` - not dismissible
 */
export interface InsightRef {
  source: InsightSource;
  key: string;
}

/**
 * The shape of a key each detector can still produce. A dismissal whose key
 * is not of its source's shape - the bare item, goal or plan id the first
 * detectors keyed by (before B32 added the period and reason), the
 * period-only goal_behind key before K3 added the statement - can never
 * match a current insight, so nothing is hiding behind it. A Record over
 * InsightSource, so a new detector cannot be added without saying here what
 * its keys look like.
 */
const DISMISSAL_KEY_SHAPES: Record<InsightSource, RegExp> = {
  not_posting: /^[^:]+:[a-z_]+$/,
  posting_run_failed: /^run$/,
  afford_viability: /^[^:]+:\d{4}-\d{2}-[AB]$/,
  recurring_suggestion: /^[^:]+:[\s\S]+$/,
  goal_behind: /^[^:]+:\d{4}-\d{2}-[AB]:(plan|contributed)$/,
  goal_forecast_risk: /^[^:]+:\d{4}-\d{2}-[AB]$/,
};

/** A dismissal older than this many days is dropped by the Inbox's daily clean-up. */
export const DISMISSAL_MAX_AGE_DAYS = 120;

/**
 * Why a stored dismissal is dropped, or null when it stays: "unmatched" when
 * no current detector can produce its key (removed source or legacy key
 * shape), "expired" when it is older than DISMISSAL_MAX_AGE_DAYS. Unmatched
 * wins when both hold, so each row is counted once.
 */
export function staleDismissalReason(
  row: { source: string; key: string; dismissedAt: Date },
  now: Date,
): "unmatched" | "expired" | null {
  const shape = isInsightSource(row.source) ? DISMISSAL_KEY_SHAPES[row.source] : null;
  if (!shape || !shape.test(row.key)) return "unmatched";
  const ageMs = now.getTime() - row.dismissedAt.getTime();
  return ageMs > DISMISSAL_MAX_AGE_DAYS * 86_400_000 ? "expired" : null;
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
  /** A line under the evidence, the signal's own surface's hint (a suggestion that may repeat a tracked item). */
  hint?: string;
}

export function insightId(ref: InsightRef): string {
  return `${ref.source}:${ref.key}`;
}

/**
 * Everything the detectors read, already computed by each signal's own code:
 *   recurringPosting     this request's catch-up posting run (AppContext.recurringPosting)
 *   recurringPostingFailure  why that run threw, when it did (AppContext.recurringPostingFailure)
 *   affordRechecks       the Afford tracker's re-check of every recorded plan (recheckAffordItems)
 *   recurringSuggestions the pattern detector's current suggestions (findRecurringSuggestions)
 *   goalRoadmaps         every goal's period plan and its two statements (getGoalRoadmapStatuses)
 *   goalForecasts        every dated goal's walk to its target date through Afford's projection (forecastGoalFunding)
 * plus the dictionary the titles and labels are written in (and the language
 * the dates and period names in them are spelled in) and the display
 * currency the roadmap figures are in.
 */
export interface InsightContext {
  dictionary: Dictionary;
  locale: Locale;
  /** What the goal roadmap figures are in (AppContext.displayCurrency). */
  displayCurrency: string;
  recurringPosting: RecurringPostingSummary | null;
  recurringPostingFailure: RecurringPostingFailure | null;
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
  const reasonText: Record<PostingSkipReason, string> = {
    missing_account: reasons.notPostingReasonMissingAccount,
    missing_goal: reasons.notPostingReasonMissingGoal,
    missing_account_and_goal: reasons.notPostingReasonMissingAccountAndGoal,
    account_archived: reasons.notPostingReasonAccountArchived,
    goal_achieved: reasons.notPostingReasonGoalAchieved,
    rounds_to_zero: reasons.notPostingReasonRoundsToZero,
  };
  // Keyed by the item and why it is not posting, so a dismissed skip does not
  // hide the item's later failure (or a different skip). A failure's key says
  // `failed`, not the error text, which can differ run to run.
  const insight = (id: string, reason: string, name: string, evidence: InsightEvidence[]): Insight => ({
    id: insightId({ source: "not_posting", key: `${id}:${reason}` }),
    source: "not_posting",
    key: `${id}:${reason}`,
    severity: "critical",
    title: t.notPostingTitle(name),
    evidence,
    actionHref: "/recurring",
    dismissible: true,
  });
  return [
    ...recurringPosting.skipped.map((item) =>
      insight(item.id, item.reason, item.name, [
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
      insight(item.id, "failed", item.name, [
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
 * The posting run itself threw, so nothing was posted and no per-item list
 * exists to show (detectNotPosting has none to read). Critical, and not
 * dismissible: it is not a condition the user resolves but a fact about the
 * last run, and it goes away by itself when a later run succeeds.
 */
export const detectPostingRunFailed: InsightDetector = ({ dictionary, recurringPostingFailure }) => {
  if (!recurringPostingFailure) return [];
  const t = dictionary.inbox;
  return [
    {
      id: insightId({ source: "posting_run_failed", key: "run" }),
      source: "posting_run_failed",
      key: "run",
      severity: "critical",
      title: t.postingRunFailedTitle,
      evidence: [
        { kind: "text", label: t.notPostingReason, value: recurringPostingFailure.reason },
        { kind: "text", label: t.postingRunFailedEffect, value: t.postingRunFailedEffectValue },
      ],
      actionHref: "/recurring",
      dismissible: false,
    } satisfies Insight,
  ];
};

/**
 * The Dashboard's Afford-viability alert and the Recurring page's "Short by"
 * badge: every recorded plan whose remaining payments no longer pass Afford's
 * two checks, reduced to the first failing period exactly as
 * summarizeAffordViability reduces it for the badge. Advisory: it projects a
 * period that has not happened yet (the Dashboard and Recurring copy call
 * the same check advisory), and it is keyed by the item and that failing
 * period, so a dismissal hides this shortfall and not a new one elsewhere.
 */
export const detectAffordViability: InsightDetector = ({ dictionary, locale, affordRechecks }) => {
  const t = dictionary.inbox;
  return notViableAffordItems(affordRechecks).flatMap((item) => {
    const viability = summarizeAffordViability(item.verdict);
    if (viability.status !== "short") return [];
    const failing = item.verdict.failing[0];
    const check = failing.account.passes ? failing.flexible : failing.account;
    const key = `${item.itemId}:${viability.periodKey}`;
    return [
      {
        id: insightId({ source: "afford_viability", key }),
        source: "afford_viability",
        key,
        severity: "advisory",
        title: t.affordTitle(item.name),
        evidence: [
          { kind: "money", label: t.affordShortfall, amount: viability.shortfall, currency: viability.currency },
          { kind: "text", label: t.affordPeriod, value: formatPeriodShort(viability.period, locale) },
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
export const detectRecurringSuggestions: InsightDetector = ({ dictionary, locale, recurringSuggestions }) => {
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
            formatDate(first.date, locale),
            formatDate(last.date, locale),
          ),
        },
        { kind: "text", label: t.suggestionAccount, value: suggestion.accountName },
        ...suggestion.nextDates.map(
          (date): InsightEvidence => ({ kind: "date", label: t.suggestionNext, date: toISODate(date) }),
        ),
      ],
      actionHref: "/recurring",
      dismissible: true,
      // The card's own hint, from the same check (repeatedItem): the charge
      // may already be tracked under another name or account.
      ...(suggestion.mayRepeat
        ? { hint: dictionary.recurring.suggestionMayRepeat(suggestion.mayRepeat.itemName, suggestion.mayRepeat.accountName) }
        : {}),
    } satisfies Insight;
  });
};

/**
 * The goal page's two notes about a confirmed plan (decision 5.3, option C),
 * each read off the same GoalRoadmapStatus the page reads:
 *
 *   planning        the plan period's confirmed plan funds less by hand than
 *                   the roadmap asks (planningShortfall): a dated goal only -
 *                   an undated goal's figure is its whole remaining balance,
 *                   not a pace to be behind. A goal the plan gave nothing,
 *                   because the accounts had no room, counts as planned 0 and
 *                   is flagged like any other. When the room could not cover
 *                   the roadmap, that rides along as evidence.
 *   follow-through  a period's plan was not carried out: what was planned
 *                   (by hand and scheduled) is neither contributed nor still
 *                   due to post (followThroughShortfall). Raised only in the
 *                   period's last FOLLOW_THROUGH_ALERT_DAYS or once it has
 *                   ended (the status carries 0 before then), for any goal
 *                   not reached.
 *
 * Keyed by the goal, the period and the statement, so dismissing one hides
 * neither the other nor the same statement in another period.
 */
export const detectGoalsBehind: InsightDetector = ({ dictionary, locale, displayCurrency, goalRoadmaps }) => {
  const t = dictionary.inbox;
  const money = (label: string, amount: number): InsightEvidence => ({ kind: "money", label, amount, currency: displayCurrency });
  return goalRoadmaps.flatMap((status) => {
    const found: Insight[] = [];
    if (status.planningShortfall > 0 && status.planned !== null) {
      const key = `${status.goalId}:${status.period.key}:plan`;
      found.push({
        id: insightId({ source: "goal_behind", key }),
        source: "goal_behind",
        key,
        severity: "advisory",
        title: t.goalTitle(status.name),
        evidence: [
          money(t.goalBehindBy, status.planningShortfall),
          money(t.goalRoadmap, status.byHand),
          money(t.goalPlanned, status.planned),
          { kind: "text", label: t.goalPeriod, value: formatPeriodShort(status.period, locale) },
          ...(status.targetDate ? [{ kind: "date", label: t.goalTarget, date: toISODate(status.targetDate) } satisfies InsightEvidence] : []),
          ...(status.roomShortfall > 0 ? [money(t.goalRoomShortfall, status.roomShortfall)] : []),
        ],
        actionHref: `/goals/${status.goalId}`,
        dismissible: true,
      });
    }
    if (status.followThroughShortfall > 0 && status.planned !== null) {
      const key = `${status.goalId}:${status.period.key}:contributed`;
      found.push({
        id: insightId({ source: "goal_behind", key }),
        source: "goal_behind",
        key,
        severity: "advisory",
        title: t.goalFollowThroughTitle(status.name),
        evidence: [
          money(t.goalNotContributed, status.followThroughShortfall),
          money(t.goalPlanned, status.planned),
          ...(status.scheduled > 0 ? [money(t.goalScheduled, status.scheduled)] : []),
          money(t.goalContributed, status.contributed),
          { kind: "text", label: t.goalPeriod, value: formatPeriodShort(status.period, locale) },
        ],
        actionHref: `/goals/${status.goalId}`,
        dismissible: true,
      });
    }
    return found;
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
 * the pace asked, the goal's recurring contributions due there (the room is
 * asked only for the rest), what the room could give, each account with room
 * there and the target date. Not the goal page's "behind the roadmap" note, which
 * measures what the plan period's confirmed check-in set aside
 * (detectGoalsBehind): this asks whether the periods ahead can keep the pace
 * up at all. A confirmed period is never in the walk, and an undated goal
 * has no target date to walk to (forecastGoalFunding leaves both out).
 * Advisory: nothing here is committed - the estimate is the discretionary
 * funding the user adjusts check-in to check-in. Keyed by the goal and the
 * first short period, so a dismissal hides that shortfall and not one that
 * appears in a different period.
 */
export const detectGoalForecastRisk: InsightDetector = ({ dictionary, locale, goalForecasts }) => {
  const t = dictionary.inbox;
  return goalForecasts.flatMap((forecast) => {
    const summary = summarizeGoalForecast(forecast);
    if (summary.status !== "short") return [];
    const { period } = summary;
    const withRoom = period.draws.filter((draw) => draw.headroom > 0);
    const key = `${forecast.goalId}:${period.period.key}`;
    return [
      {
        id: insightId({ source: "goal_forecast_risk", key }),
        source: "goal_forecast_risk",
        key,
        severity: "advisory",
        title: t.forecastTitle(forecast.name),
        evidence: [
          { kind: "money", label: t.forecastShortfall, amount: period.shortfall, currency: forecast.currency },
          { kind: "text", label: t.forecastPeriod, value: formatPeriodShort(period.period, locale) },
          { kind: "money", label: t.forecastPace, amount: period.pace, currency: forecast.currency },
          ...(period.scheduled > 0
            ? [{ kind: "money", label: t.forecastScheduled, amount: period.scheduled, currency: forecast.currency } satisfies InsightEvidence]
            : []),
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
  detectPostingRunFailed,
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

/**
 * `insights` split by `dismissed`: `visible` is what the Inbox shows and the
 * nav badge counts, `hidden` the current insights a dismissal is keeping out
 * (a dismissal for evidence that is no longer current matches nothing and is
 * not in either). An insight that is not dismissible stays visible whatever
 * the dismissals say.
 */
export function partitionDismissed(
  insights: Insight[],
  dismissed: InsightRef[],
): { visible: Insight[]; hidden: Insight[] } {
  const gone = new Set(dismissed.map(insightId));
  const visible: Insight[] = [];
  const hidden: Insight[] = [];
  for (const insight of insights) (insight.dismissible && gone.has(insight.id) ? hidden : visible).push(insight);
  return { visible, hidden };
}

/** `insights` without the ones in `dismissed`. */
export function withoutDismissed(insights: Insight[], dismissed: InsightRef[]): Insight[] {
  return partitionDismissed(insights, dismissed).visible;
}

/**
 * What the empty Inbox says. Nothing dismissed: the all-clear list. Something
 * current is hidden by a dismissal: say so, with how many, rather than claim
 * everything is fine.
 */
export function inboxEmptyDescription(t: Dictionary["inbox"], hiddenCount: number): string {
  return hiddenCount > 0 ? t.emptyDescriptionDismissed(hiddenCount) : t.emptyDescription;
}
