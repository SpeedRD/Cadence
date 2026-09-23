"use client";

import { XIcon } from "lucide-react";
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

  const dismissForToday = async () => {
    const result = await dismissPaydayPromptAction(null);
    if (result?.error) toast.error(result.error);
  };

  // Below sm the prompt is one row - title, Start, and Not now as an x - so it
  // costs the phone Dashboard one row instead of pushing the hero figure toward
  // the fold. The description goes there: Step 1 of the wizard says the same.
  return (
    <Card size="sm" className="max-sm:flex-row max-sm:items-center">
      <CardHeader className="max-sm:min-w-0 max-sm:flex-1 max-sm:gap-0 max-sm:pe-0">
        <CardTitle>{t.bannerTitle}</CardTitle>
        <CardDescription className="max-sm:hidden">{t.bannerDescription}</CardDescription>
      </CardHeader>
      <CardContent className="flex gap-2 max-sm:ps-0">
        <Button size="sm" onClick={() => setOpen(true)}>
          {t.startCheckin}
        </Button>
        <Button size="sm" variant="ghost" className="max-sm:hidden" onClick={dismissForToday}>
          {t.dismissForToday}
        </Button>
        <Button
          size="icon-lg"
          variant="ghost"
          className="sm:hidden"
          aria-label={t.dismissForToday}
          onClick={dismissForToday}
        >
          <XIcon />
        </Button>
      </CardContent>
      <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
    </Card>
  );
}
