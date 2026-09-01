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
import { getAppContext } from "@/lib/data/context";
import { logoutAction } from "@/server/actions/auth";
import { recalculateGoalsAction } from "@/server/actions/settings";

export const metadata = { title: "Settings - Cadence" };

export default async function SettingsPage() {
  const context = await getAppContext();
  const timezone = process.env.APP_TIMEZONE || "UTC";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="A single-user ledger: one PIN, one display currency, one set of rules."
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Display currency</CardTitle>
            <CardDescription>
              Every figure in the app is converted into this currency.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DisplayCurrencyForm value={context.displayCurrency} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Exchange rates</CardTitle>
            <CardDescription>
              USD-based, cached for 24 hours, cross rates derived through USD.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="grid grid-cols-3 gap-2 text-sm">
              {CURRENCIES.map((code) => (
                <div key={code}>
                  <dt className="eyebrow">USD to {code}</dt>
                  <dd className="figure">
                    {formatRate(context.rates.rates[code] ?? 1)}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              {context.rates.fetchedAt
                ? `Last fetched ${context.rates.fetchedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`
                : "No rates fetched yet"}
              {context.rates.stale
                ? " · the rate service was unreachable, using the last known values"
                : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Goal progress</CardTitle>
            <CardDescription>
              Goal totals are cached for speed. Contributions are the source of
              truth - rebuild the cache from them if anything looks off.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ActionButton action={recalculateGoalsAction} size="sm">
              <RefreshCw className="size-3.5" />
              Recalculate goal totals
            </ActionButton>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Email connections</CardTitle>
            <CardDescription>
              Gmail and Outlook accounts Cadence pulls transactional emails from,
              staged on /review before they become transactions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/connections">
                <Mail className="size-3.5" />
                Manage connections
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Session</CardTitle>
            <CardDescription>
              Pay periods are resolved in {timezone}. Currencies available:{" "}
              {CURRENCIES.map((code) => CURRENCY_LABELS[code] ?? code).join(", ")}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                <LogOut className="size-3.5" />
                Lock Cadence
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
