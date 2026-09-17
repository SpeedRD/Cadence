import { Bell, TriangleAlert } from "lucide-react";

import { InsightList } from "@/components/inbox/insight-list";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/stat";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAppContext } from "@/lib/data/context";
import { getInsights } from "@/lib/data/insights";
import { getDictionary } from "@/lib/i18n";

export const metadata = { title: "Inbox - Cadence" };

/**
 * Every current insight (src/lib/insights.ts) in one place, critical ones
 * first. The list is the same request-cached getInsights() the layout's nav
 * badge counts, so the badge and this page always agree. Each row links to
 * the surface that can resolve it and can be dismissed for good; nothing
 * here changes the signal itself.
 */
export default async function InboxPage() {
  const [context, insights] = await Promise.all([getAppContext(), getInsights()]);
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
        <EmptyState title={t.emptyTitle} description={t.emptyDescription} />
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
