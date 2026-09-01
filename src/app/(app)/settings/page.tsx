import { LogOut, Mail, RefreshCw } from "lucide-react";
import Link from "next/link";

import { ActionButton } from "@/components/form/action-button";
import { PageHeader } from "@/components/page-header";
import { DisplayCurrencyForm } from "@/components/settings/display-currency-form";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CURRENCIES, CURRENCY_LABELS, formatRate } from "@/lib/currency";
import { appTimeZone } from "@/lib/date";
import { getAppContext } from "@/lib/data/context";
import { getDictionary } from "@/lib/i18n";
import { logoutAction } from "@/server/actions/auth";
import { recalculateGoalsAction } from "@/server/actions/settings";

export const metadata = { title: "Settings - Cadence" };

export default async function SettingsPage() {
  const context = await getAppContext();
  const timezone = appTimeZone();
  const t = getDictionary(context.language).settingsPage;

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
            <dl className="grid grid-cols-3 gap-2 text-sm">
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
                ? t.lastFetched(context.rates.fetchedAt.toISOString().slice(0, 16).replace("T", " "))
                : t.noRatesFetched}
              {context.rates.stale
                ? t.rateServiceUnreachable
                : ""}
            </p>
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
