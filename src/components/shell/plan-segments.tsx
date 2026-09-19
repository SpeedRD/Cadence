"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { buildNav, isActive, PLAN_HREFS } from "@/components/shell/nav-model";
import { tabsListVariants } from "@/components/ui/tabs";
import { getDictionary, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The Plan tab's screen, below md: a segmented control over Budgets,
 * Recurring, Goals and Afford, each segment being the existing page
 * unchanged at its existing URL. Rendered by the shell above whichever of
 * the four is open (and above their deep pages, which keep their own back
 * links), and nothing at all anywhere else. Links styled as the Tabs
 * primitive's list rather than Radix tabs: these switch routes, so they
 * carry aria-current, not aria-selected.
 */
export function PlanSegments({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const t = getDictionary(locale).nav;
  if (!PLAN_HREFS.some((href) => isActive(pathname, href))) return null;

  const byHref = new Map(buildNav(t).map((item) => [item.href, item]));

  return (
    <nav aria-label={t.plan} className="mb-5 md:hidden">
      <ul className={cn(tabsListVariants(), "flex h-9 w-full")}>
        {PLAN_HREFS.map((href) => {
          const item = byHref.get(href);
          if (!item) return null;
          const active = isActive(pathname, href);
          return (
            <li key={href} className="flex min-w-0 flex-1">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // 11px, the tab bar's own label size: "Presupuestos" is
                  // 70px at 11px and 77px at 12px, in an 84px segment at 375.
                  "flex h-full min-w-0 flex-1 items-center justify-center rounded-md border border-transparent px-1 text-[0.6875rem] font-medium whitespace-nowrap transition-colors",
                  active
                    ? "bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30"
                    : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
                )}
              >
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
