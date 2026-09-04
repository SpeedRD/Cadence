import { LogOut, Mail, RefreshCw, Tags } from "lucide-react";
import Link from "next/link";

import { ActionButton } from "@/components/form/action-button";
import { PageHeader } from "@/components/page-header";
import { DisplayCurrencyForm } from "@/components/settings/display-currency-form";
import { EssentialCategoryToggle } from "@/components/settings/essential-category-toggle";
import { PlanningPreferencesForm } from "@/components/settings/planning-preferences-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getSettings } from "@/lib/auth";
import { CURRENCIES, CURRENCY_LABELS, formatRate } from "@/lib/currency";
import { appTimeZone, formatDateTimeInAppZone } from "@/lib/date";
import { getAppContext } from "@/lib/data/context";
import { getDictionary } from "@/lib/i18n";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { logoutAction } from "@/server/actions/auth";
import { recalculateGoalsAction } from "@/server/actions/settings";
import { backfillCategorizationAction } from "@/server/actions/transactions";

export const metadata = { title: "Settings - Cadence" };

export default async function SettingsPage() {
  const context = await getAppContext();
  const timezone = appTimeZone();
  const t = getDictionary(context.language).settingsPage;
  const settings = await getSettings();
  const eligibleCategories = await prisma.category.findMany({
    where: { kind: "EXPENSE", isSubscriptionDefault: false, isSavingsDefault: false },
    orderBy: { name: "asc" },
  });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t.title}
        description={t.description}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t.displayCurrencyTitle}</CardTitle>
            <CardDescription>
              {t.displayCurrencyDescription}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DisplayCurrencyForm value={context.displayCurrency} locale={context.language} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.exchangeRates}</CardTitle>
            <CardDescription>
              {t.exchangeRatesDescription}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-3">
              {CURRENCIES.map((code) => (
                <div key={code}>
                  <dt className="eyebrow">{t.usdTo(code)}</dt>
                  <dd className="figure">
                    {formatRate(context.rates.rates[code] ?? 1)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {context.rates.fetchedAt
                ? t.lastFetched(formatDateTimeInAppZone(context.rates.fetchedAt))
                : t.noRatesFetched}
              {context.rates.stale
                ? t.rateServiceUnreachable
                : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.planningPreferencesTitle}</CardTitle>
            <CardDescription>{t.planningPreferencesDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            <PlanningPreferencesForm
              bufferPercent={settings.bufferPercent}
              bufferFloorAmount={num(settings.bufferFloorAmount)}
              bufferFloorCurrency={settings.bufferFloorCurrency}
              carryoverIncludedByDefault={settings.carryoverIncludedByDefault}
              locale={context.language}
            />
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t.essentialCategoriesTitle}</CardTitle>
            <CardDescription>{t.essentialCategoriesDescription}</CardDescription>
          </CardHeader>
          <CardContent>
            {eligibleCategories.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.noEligibleCategories}</p>
            ) : (
              <ul className="divide-y divide-border/70">
                {eligibleCategories.map((category) => (
                  <li key={category.id} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                    <span className="flex items-center gap-2 text-sm">
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: category.color }}
                      />
                      {category.name}
                    </span>
                    <EssentialCategoryToggle
                      categoryId={category.id}
                      initialValue={category.isEssentialFixed}
                      ariaLabel={t.essentialToggleAria(category.name)}
                      errorMessage={t.categoryNoLongerExists}
                    />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.goalProgress}</CardTitle>
            <CardDescription>
              {t.goalProgressDescription}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionButton action={recalculateGoalsAction} size="sm">
              <RefreshCw className="size-3.5" />
              {t.recalculateGoalTotals}
            </ActionButton>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.categorizeHistory}</CardTitle>
            <CardDescription>
              {t.categorizeHistoryDescription}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionButton action={backfillCategorizationAction} size="sm">
              <Tags className="size-3.5" />
              {t.categorizeHistoryAction}
            </ActionButton>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.emailConnections}</CardTitle>
            <CardDescription>
              {t.emailConnectionsDescription}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/connections">
                <Mail className="size-3.5" />
                {t.manageConnections}
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t.session}</CardTitle>
            <CardDescription>
              {t.sessionDescription(
                timezone,
                CURRENCIES.map((code) => CURRENCY_LABELS[code] ?? code).join(", "),
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                <LogOut className="size-3.5" />
                {t.lockCadence}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
