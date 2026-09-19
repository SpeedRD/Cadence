import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { CountBadge } from "@/components/shell/nav-links";
import { buildNav, MORE_HREFS } from "@/components/shell/nav-model";
import { Card } from "@/components/ui/card";
import { getAppContext } from "@/lib/data/context";
import { getInsights } from "@/lib/data/insights";
import { getDictionary } from "@/lib/i18n";

export const metadata = { title: "More - Cadence" };

/**
 * The phone tab bar's More tab: a plain list of the four occasional pages
 * (Accounts, Reports, Review, Settings), each row the same destination the
 * desktop sidebar links to. Reachable by URL at any width; from md up the
 * sidebar already lists these, so the page is only ever opened from the bar.
 */
export default async function MorePage() {
  const [context, insights] = await Promise.all([getAppContext(), getInsights()]);
  const dictionary = getDictionary(context.language);
  const t = dictionary.more;
  // Same per-href counts the layout hands the shell, so a row's pill matches
  // the tab's.
  const badges: Partial<Record<string, number>> = { "/inbox": insights.length };
  const byHref = new Map(buildNav(dictionary.nav).map((item) => [item.href, item]));

  return (
    <div className="space-y-5">
      <PageHeader title={t.title} description={t.description} />
      <Card className="py-0">
        <ul className="divide-y divide-border/70">
          {MORE_HREFS.map((href) => {
            const item = byHref.get(href);
            if (!item) return null;
            const count = badges[href] ?? 0;
            return (
              <li key={href}>
                <Link
                  href={href}
                  className="flex min-h-12 items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-sidebar-accent/60"
                >
                  <item.icon className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {count > 0 ? (
                    <CountBadge count={count} label={dictionary.nav.badgeLabel(count)} />
                  ) : null}
                  <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
