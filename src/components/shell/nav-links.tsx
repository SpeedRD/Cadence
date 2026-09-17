"use client";

import {
  Bell,
  Calculator,
  Coins,
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
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { getDictionary, type Locale } from "@/lib/i18n";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
}

/** Counts to show as a red pill on a link, by href. Absent or zero means no pill - like an app icon badge. */
export type NavBadges = Partial<Record<string, number>>;

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function CountBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      aria-label={label}
      className="figure ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--critical)] px-1 text-[0.625rem] leading-none font-semibold text-white"
    >
      {count}
    </span>
  );
}

export function NavLinks({
  variant,
  locale,
  badges = {},
}: {
  variant: "sidebar" | "bar";
  locale: Locale;
  badges?: NavBadges;
}) {
  const pathname = usePathname();
  const t = getDictionary(locale).nav;
  const badgeFor = (href: string) => {
    const count = badges[href] ?? 0;
    return count > 0 ? <CountBadge count={count} label={t.badgeLabel(count)} /> : null;
  };

  const NAV: NavItem[] = [
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

  if (variant === "bar") {
    return (
      <nav className="flex gap-1 overflow-x-auto px-4 py-2">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href, item.exact);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                active
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
              {badgeFor(item.href)}
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="grid gap-0.5 px-3">
      {NAV.map((item) => {
        const active = isActive(pathname, item.href, item.exact);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
              active
                ? "bg-sidebar-accent text-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "absolute left-0 h-4 w-0.5 rounded-full bg-primary transition-opacity",
                active ? "opacity-100" : "opacity-0",
              )}
            />
            <item.icon className="size-4" />
            {item.label}
            {badgeFor(item.href)}
          </Link>
        );
      })}
    </nav>
  );
}
