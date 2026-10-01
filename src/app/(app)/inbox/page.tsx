import { Bell, TriangleAlert } from "lucide-react";

import { InsightList } from "@/components/inbox/insight-list";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAppContext } from "@/lib/data/context";
import { getInsightState, pruneInsightDismissals } from "@/lib/data/insights";
import { getDictionary } from "@/lib/i18n";
import { inboxEmptyDescription } from "@/lib/insights";

export const metadata = { title: "Inbox - Cadence" };

/**
 * Every current insight (src/lib/insights.ts) in one place, critical ones
 * first. The list is the same request-cached run (getInsightState) the
 * layout's nav badge counts, so the badge and this page always agree. Each
 * row links to the surface that can resolve it and can be dismissed (that
 * evidence only); nothing here changes the signal itself.
 */
export default async function InboxPage() {
  // The daily clean-up of dismissals that can no longer hide anything. It runs
  // after the insights are read, so this page shows what it showed before the
  // clean-up; a row dropped for its age lets its insight back from the next
  // load. A failure is logged, never shown - the page does not depend on it.
  const [context, { insights, dismissedCount }] = await Promise.all([getAppContext(), getInsightState()]);
  await pruneInsightDismissals().catch((error) => console.error("[inbox] dismissal clean-up failed", error));
  const t = getDictionary(context.language).inbox;
  const critical = insights.filter((insight) => insight.severity === "critical");
  const advisory = insights.filter((insight) => insight.severity === "advisory");

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={insights.length > 0 ? t.pendingCount(insights.length) : t.description}
      />

      {insights.length === 0 ? (
        <EmptyState title={t.emptyTitle} description={inboxEmptyDescription(t, dismissedCount)} />
      ) : null}

      {critical.length > 0 ? (
        <Card data-severity-group="critical">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-[var(--critical)]" />
              {t.severityCritical}
            </CardTitle>
            <CardDescription>{t.severityCriticalHint}</CardDescription>
          </CardHeader>
          <CardContent>
            <InsightList insights={critical} locale={context.language} />
          </CardContent>
        </Card>
      ) : null}

      {advisory.length > 0 ? (
        <Card data-severity-group="advisory">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bell className="size-4 text-[var(--warning)]" />
              {t.severityAdvisory}
            </CardTitle>
            <CardDescription>{t.severityAdvisoryHint}</CardDescription>
          </CardHeader>
          <CardContent>
            <InsightList insights={advisory} locale={context.language} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
