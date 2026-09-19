import {
  Bell,
  Calculator,
  CalendarDays,
  Coins,
  Ellipsis,
  Flag,
  Gauge,
  Inbox,
  Receipt,
  Repeat,
  Settings,
  SlidersHorizontal,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { Dictionary } from "@/lib/i18n";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

/** Counts to show as a red pill on a link, by href. Absent or zero means no pill - like an app icon badge. */
export type NavBadges = Partial<Record<string, number>>;

export function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one list of destinations. The desktop sidebar renders it flat; the
 * phone tab bar (mobile-tab-bar.tsx) folds it into five tabs by href, so a
 * page added here shows up in both without a second list to keep in step.
 */
export function buildNav(t: Dictionary["nav"]): NavItem[] {
  return [
    { href: "/", label: t.dashboard, icon: Gauge, exact: true },
    // Every standing insight in one place (src/lib/insights.ts); the badge
    // counts them. The bell rather than the inbox tray: "inbox" already means
    // a connected mailbox on the Settings connections page, and the tray icon
    // is the Review queue's below.
    { href: "/inbox", label: t.inbox, icon: Bell },
    { href: "/transactions", label: t.transactions, icon: Receipt },
    // Kept as "Review", not renamed to "Inbox" to match the icon: "inbox"
    // already means a connected mailbox on the Settings connections page.
    { href: "/review", label: t.review, icon: Inbox },
    { href: "/accounts", label: t.accounts, icon: Wallet },
    { href: "/budgets", label: t.budgets, icon: SlidersHorizontal },
    { href: "/recurring", label: t.recurring, icon: Repeat },
    { href: "/afford", label: t.afford, icon: Calculator },
    { href: "/goals", label: t.goals, icon: Flag },
    { href: "/reports", label: t.reports, icon: Coins },
    { href: "/settings", label: t.settings, icon: Settings },
  ];
}

/**
 * How the phone tab bar folds the flat list, by how often each page is
 * opened: daily pages get a tab each; the four "plan the period" pages sit
 * behind one Plan hub tab (a segmented control over them, plan-segments.tsx);
 * the four occasional pages sit behind a More tab that opens a plain list
 * (/more). Order within each group is the sidebar's.
 */
export const PLAN_HREFS = ["/budgets", "/recurring", "/goals", "/afford"] as const;
export const MORE_HREFS = ["/accounts", "/reports", "/review", "/settings"] as const;
/** The More tab's own list screen, active alongside the pages it lists. */
export const MORE_HUB_HREF = "/more";

export interface MobileTab {
  /** Where a tap goes. A hub tab goes to its first (or own) screen. */
  href: string;
  label: string;
  icon: LucideIcon;
  /** Every href this tab is "current" for; the tab also sums their badges. */
  hrefs: readonly string[];
  exact?: boolean;
}

export function buildMobileTabs(t: Dictionary["nav"], nav: NavItem[]): MobileTab[] {
  const byHref = new Map(nav.map((item) => [item.href, item]));
  const own = (href: string): MobileTab => {
    const item = byHref.get(href);
    if (!item) throw new Error(`Nav item missing for ${href}`);
    return { href, label: item.label, icon: item.icon, hrefs: [href], exact: item.exact };
  };
  return [
    own("/"),
    own("/transactions"),
    { href: PLAN_HREFS[0], label: t.plan, icon: CalendarDays, hrefs: PLAN_HREFS },
    own("/inbox"),
    {
      href: MORE_HUB_HREF,
      label: t.more,
      icon: Ellipsis,
      hrefs: [MORE_HUB_HREF, ...MORE_HREFS],
    },
  ];
}

export function isTabActive(pathname: string, tab: MobileTab) {
  return tab.hrefs.some((href) => isActive(pathname, href, tab.exact));
}

export function sumBadges(badges: NavBadges, hrefs: readonly string[]) {
  return hrefs.reduce((total, href) => total + (badges[href] ?? 0), 0);
}
