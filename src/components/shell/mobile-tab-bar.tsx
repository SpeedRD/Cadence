"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";

import { CountBadge } from "@/components/shell/nav-links";
import {
  buildMobileTabs,
  buildNav,
  isTabActive,
  sumBadges,
  type NavBadges,
} from "@/components/shell/nav-model";
import { getDictionary, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The phone's navigation (below md): five tabs docked to the bottom edge,
 * where the thumb is. Dashboard, Transactions and Inbox are their own tabs;
 * Plan and More each stand for a group of pages (nav-model.ts) and read as
 * current on every page in their group, so "where am I?" is answered on
 * every screen rather than only on the three the old strip could show.
 *
 * Same material as the header - the app's one floating surface class - and
 * never overlapping it; the app-chrome hook is what globals.css's
 * prefers-reduced-transparency block turns solid. Sticky rather than fixed
 * so it takes its own room in the column and content can never end under
 * it. The tab is the whole target (49px plus the home-indicator inset),
 * not the icon.
 */
export function MobileTabBar({
  locale,
  badges = {},
}: {
  locale: Locale;
  badges?: NavBadges;
}) {
  const pathname = usePathname();
  const t = getDictionary(locale).nav;
  const tabs = buildMobileTabs(t, buildNav(t));

  return (
    <nav
      aria-label={t.tabBarLabel}
      className="app-chrome sticky bottom-0 z-30 border-t border-border/70 bg-background/85 pb-[env(safe-area-inset-bottom)] supports-backdrop-filter:backdrop-blur md:hidden"
    >
      <ul className="flex h-[49px] items-stretch">
        {tabs.map((tab) => {
          const active = isTabActive(pathname, tab);
          const count = sumBadges(badges, tab.hrefs);
          return (
            <li key={tab.href} className="min-w-0 flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // No side padding: the dictionary's longest label
                  // ("Transacciones", 73px at 11px) needs the full 75px a
                  // 375-wide screen gives each tab.
                  "relative flex h-full flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors",
                  active ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {/* The sidebar's current-page marker, laid along the top edge:
                    teal is wayfinding only, so this is the tab's one colour. */}
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-0 h-0.5 w-6 rounded-full bg-primary transition-opacity",
                    active ? "opacity-100" : "opacity-0",
                  )}
                />
                <PendingDip>
                  <span className="relative">
                    <tab.icon className="size-5" />
                    {count > 0 ? (
                      <span className="absolute -top-1.5 -right-2.5">
                        <CountBadge count={count} label={t.badgeLabel(count)} />
                      </span>
                    ) : null}
                  </span>
                  <span className="max-w-full truncate leading-none">{tab.label}</span>
                </PendingDip>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The tapped tab's acknowledgement: while its destination is still being
 * rendered on the server (every route is force-dynamic), the icon and label
 * dip in opacity, so the tap visibly landed before the page frame arrives.
 * Opacity only, on a wrapper that takes the Link's own column layout, so
 * nothing shifts. Must render inside the Link - useLinkStatus reads it.
 */
function PendingDip({ children }: { children: React.ReactNode }) {
  const { pending } = useLinkStatus();
  return (
    <span
      className={cn(
        "flex max-w-full min-w-0 flex-col items-center gap-1 transition-opacity duration-150",
        pending && "opacity-50",
      )}
    >
      {children}
    </span>
  );
}
