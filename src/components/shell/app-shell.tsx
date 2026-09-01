import Link from "next/link";

import { NavLinks } from "@/components/shell/nav-links";
import { CurrencySwitcher } from "@/components/shell/currency-switcher";
import { LanguageSwitcher } from "@/components/shell/language-switcher";
import { LogoutButton } from "@/components/shell/logout-button";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { PeriodRail } from "@/components/period-rail";

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
  const { currentPeriod } = context;
  const t = getDictionary(context.language);
  const remaining = daysRemainingInPeriod(context.today, currentPeriod);
  const elapsed = daysElapsedInPeriod(context.today, currentPeriod);

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
        <header className="sticky top-0 z-30 border-b border-border/70 bg-background/85 backdrop-blur">
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
          {children}
        </main>
      </div>
    </div>
  );
}
