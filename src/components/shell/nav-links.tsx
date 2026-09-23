"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import { getDictionary, type Locale } from "@/lib/i18n";
import { buildNav, isActive, type NavBadges } from "@/components/shell/nav-model";

export type { NavBadges } from "@/components/shell/nav-model";

export function CountBadge({ count, label }: { count: number; label: string }) {
  return (
    <span
      aria-label={label}
      className="figure ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--critical)] px-1 text-badge leading-none font-semibold text-white"
    >
      {count}
    </span>
  );
}

/** The desktop sidebar's flat list of every destination (md and up). */
export function NavLinks({
  locale,
  badges = {},
}: {
  locale: Locale;
  badges?: NavBadges;
}) {
  const pathname = usePathname();
  const t = getDictionary(locale).nav;
  const badgeFor = (href: string) => {
    const count = badges[href] ?? 0;
    return count > 0 ? <CountBadge count={count} label={t.badgeLabel(count)} /> : null;
  };

  const NAV = buildNav(t);

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
