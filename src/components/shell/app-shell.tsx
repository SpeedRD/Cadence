import { TriangleAlert } from "lucide-react";
import Link from "next/link";

import { NavLinks, type NavBadges } from "@/components/shell/nav-links";
import { CurrencySwitcher } from "@/components/shell/currency-switcher";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { LogoutButton } from "@/components/shell/logout-button";
import { MobileTabBar } from "@/components/shell/mobile-tab-bar";
import { PlanSegments } from "@/components/shell/plan-segments";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { PeriodRail } from "@/components/period-rail";
import { formatDateTimeInAppZone } from "@/lib/date";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { AppContext } from "@/lib/data/context";
import { getDictionary } from "@/lib/i18n";
import { daysElapsedInPeriod, daysRemainingInPeriod } from "@/lib/period";

export function AppShell({
  context,
  navBadges,
  children,
}: {
  context: AppContext;
  /** Per-link counts for the nav, computed by the layout (see AppLayout). */
  navBadges?: NavBadges;
  children: React.ReactNode;
}) {
  const { currentPeriod, rates } = context;
  const t = getDictionary(context.language);
  const remaining = daysRemainingInPeriod(context.today, currentPeriod);
  const elapsed = daysElapsedInPeriod(context.today, currentPeriod);
  // Every page in this group renders converted totals, so the one notice that
  // they are running on rates that could not be refreshed belongs here rather
  // than on each card. Same wall clock the Settings page shows.
  const staleRatesNote = rates.stale
    ? rates.fetchedAt
      ? t.shell.staleRatesSince(formatDateTimeInAppZone(rates.fetchedAt))
      : t.shell.staleRatesNeverFetched
    : null;

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar py-5 md:flex">
        <Link href="/" className="mb-7 block px-5.5">
          <PeriodRail totalDays={10} elapsed={5} compact className="mb-2.5 w-16" />
          <span className="text-lg font-semibold tracking-tight">Cadence</span>
        </Link>
        <NavLinks locale={context.language} badges={navBadges} />
        <div className="mt-auto px-5.5 pt-6">
          <p className="text-hint leading-relaxed text-muted-foreground">
            {t.shell.paidTwiceAMonth(currentPeriod.period === "A" ? "1-15" : "16-end")}
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The app's one class of floating material, shared with the phone's
            tab bar at the other edge: content scrolls under it, so the blur
            is what keeps the strip readable rather than decoration. The
            supports- guard matches DialogOverlay's - without backdrop-filter
            the 85% fill alone would let rows ghost through unblurred. The
            app-chrome hook is what globals.css's prefers-reduced-transparency
            block turns solid. */}
        <header className="app-chrome sticky top-0 z-30 border-b border-border/70 bg-background/85 supports-backdrop-filter:backdrop-blur">
          <div className="flex h-14 items-center gap-4 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              {/* Below sm the compact rail at the sidebar mark's 64px, in the
                  room language and theme leave; from sm its wider 96px. */}
              <div className="w-16 sm:w-24">
                <PeriodRail
                  totalDays={currentPeriod.totalDays}
                  elapsed={elapsed}
                  compact
                />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {currentPeriod.label}
                </p>
                <p className="text-hint text-muted-foreground">
                  {remaining === 0 ? t.shell.periodClosed : t.shell.daysLeft(remaining)}
                </p>
              </div>
            </div>

            {/* 40px tall below sm (the switchers pass h-10 over their sm
                buttons' 44; the two icon-sm buttons are 40 square), which
                fits the 56px bar; desktop keeps its compact sizes. Below md
                language and theme, set once and rarely touched, are rows in
                Settings instead, leaving the currency switcher and Lock. */}
            <div className="ml-auto flex items-center gap-1">
              <CurrencySwitcher value={context.displayCurrency} switcherLabel={t.shell.displayCurrencyLabel} />
              <LanguageSwitcher value={context.language} switcherLabel={t.shell.languageLabel} className="max-md:hidden" />
              <ThemeToggle ariaLabel={t.shell.toggleThemeAria} className="max-md:hidden" />
              <LogoutButton ariaLabel={t.shell.lockCadenceAria} />
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1180px] flex-1 px-4 py-6 sm:px-6 sm:py-8">
          {staleRatesNote ? (
            <Alert className="mb-5 border-[var(--warning)]/40 text-[var(--warning)]">
              <TriangleAlert />
              <AlertTitle>{t.shell.staleRatesTitle}</AlertTitle>
              <AlertDescription>{staleRatesNote}</AlertDescription>
            </Alert>
          ) : null}
          <PlanSegments locale={context.language} />
          {children}
        </main>

        {/* Below md the sidebar is gone and this is the navigation. */}
        <MobileTabBar locale={context.language} badges={navBadges} />
      </div>
    </div>
  );
}
