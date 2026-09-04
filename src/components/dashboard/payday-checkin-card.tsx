"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { PaydayCheckinDialog } from "@/components/payday/payday-checkin-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, type RateTable } from "@/lib/currency";
import type { PaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary, type Locale } from "@/lib/i18n";
import { summarizePaydayDraft } from "@/lib/payday";
import { dismissPaydayPromptAction } from "@/server/actions/payday";

/**
 * Shows either the "not confirmed yet" prompt (with a dismiss that only
 * suppresses today's auto-open, never the card itself) or, once this period's
 * check-in is confirmed, a compact read-only summary with a way to reopen and
 * revise the plan - the dialog pre-fills from the confirmed check-in either way.
 */
export function PaydayCheckinCard({
  draft,
  rates,
  locale,
  shouldAutoOpen,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
  shouldAutoOpen: boolean;
}) {
  const t = getDictionary(locale).payday;
  const [open, setOpen] = useState(shouldAutoOpen);

  if (draft.isEditingConfirmed) {
    const { totalIncome, essentialFixedTotal, flexibleTotal, available } = summarizePaydayDraft(draft, rates);

    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.wizardTitle(draft.periodLabel)}</CardTitle>
          <CardDescription>
            {t.summaryIncome}: {formatMoney(totalIncome, draft.displayCurrency)} · {t.summaryBuffer}:{" "}
            {formatMoney(draft.plannedBuffer, draft.displayCurrency)} · {t.summaryAvailable}:{" "}
            {formatMoney(available, draft.displayCurrency)} · {t.flexibleAllocated}:{" "}
            {formatMoney(flexibleTotal, draft.displayCurrency)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {flexibleTotal === 0 && essentialFixedTotal === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t.noAllocationsSavedNote}{" "}
              <Link href="/budgets" className="underline underline-offset-3 hover:text-foreground">
                {t.setBudgetsLink}
              </Link>
            </p>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {t.reviewConfirmedPlan}
          </Button>
        </CardContent>
        <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
      </Card>
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t.bannerTitle}</CardTitle>
        <CardDescription>{t.bannerDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t.startCheckin}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            const result = await dismissPaydayPromptAction(null);
            if (result?.error) toast.error(result.error);
          }}
        >
          {t.dismissForToday}
        </Button>
      </CardContent>
      <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
