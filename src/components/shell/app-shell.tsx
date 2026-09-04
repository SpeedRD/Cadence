import { TriangleAlert } from "lucide-react";
import Link from "next/link";

import { NavLinks } from "@/components/shell/nav-links";
import { CurrencySwitcher } from "@/components/shell/currency-switcher";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { LogoutButton } from "@/components/shell/logout-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { PeriodRail } from "@/components/period-rail";
import { formatDateTimeInAppZone } from "@/lib/date";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

import type { AppContext } from "@/lib/data/context";
import { getDictionary } from "@/lib/i18n";
import { daysElapsedInPeriod, daysRemainingInPeriod } from "@/lib/period";

export function AppShell({
  context,
  children,
}: {
  context: AppContext;
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
        <NavLinks variant="sidebar" locale={context.language} />
        <div className="mt-auto px-5.5 pt-6">
          <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
            {t.shell.paidTwiceAMonth(currentPeriod.period === "A" ? "1-15" : "16-end")}
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* The app's only floating material: content scrolls under it, so the
            blur is what keeps the strip readable rather than decoration. The
            supports- guard matches DialogOverlay's - without backdrop-filter
            the 85% fill alone would let rows ghost through unblurred. The
            app-header hook is what globals.css's prefers-reduced-transparency
            block turns solid. */}
        <header className="app-header sticky top-0 z-30 border-b border-border/70 bg-background/85 supports-backdrop-filter:backdrop-blur">
          <div className="flex h-14 items-center gap-4 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-3">
              <div className="hidden w-24 sm:block">
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
                <p className="text-[0.6875rem] text-muted-foreground">
                  {remaining === 0 ? t.shell.periodClosed : t.shell.daysLeft(remaining)}
                </p>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-1">
              <CurrencySwitcher value={context.displayCurrency} switcherLabel={t.shell.displayCurrencyLabel} />
              <LanguageSwitcher value={context.language} switcherLabel={t.shell.languageLabel} />
              <ThemeToggle ariaLabel={t.shell.toggleThemeAria} />
              <LogoutButton ariaLabel={t.shell.lockCadenceAria} />
            </div>
          </div>
          <div className="border-t border-border/70 md:hidden">
            <NavLinks variant="bar" locale={context.language} />
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
          {children}
        </main>
      </div>
    </div>
  );
}
