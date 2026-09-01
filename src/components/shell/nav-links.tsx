"use client";

import {
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

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({
  variant,
  locale,
}: {
  variant: "sidebar" | "bar";
  locale: Locale;
}) {
  const pathname = usePathname();
  const t = getDictionary(locale).nav;

  const NAV: NavItem[] = [
    { href: "/", label: t.dashboard, icon: Gauge, exact: true },
    { href: "/transactions", label: t.transactions, icon: Receipt },
    { href: "/review", label: t.review, icon: Inbox },
    { href: "/accounts", label: t.accounts, icon: Wallet },
    { href: "/budgets", label: t.budgets, icon: SlidersHorizontal },
    { href: "/recurring", label: t.recurring, icon: Repeat },
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
          </Link>
        );
      })}
    </nav>
  );
}
