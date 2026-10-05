"use client";

import { XIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";

import { PaydayCheckinDialog } from "@/components/payday/payday-checkin-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, type RateTable } from "@/lib/currency";
import { formatPeriodLong } from "@/lib/date-format";
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
  room = null,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
  shouldAutoOpen: boolean;
  /**
   * The confirmed period's flexible room (K4, src/lib/data/flexible-room.ts):
   * what was confirmed - its paycheck, buffer, carryover, goal plan and
   * essentials - against the period's whole commitments, in the display
   * currency. Null falls back to the draft's own figures.
   */
  room?: {
    income: number;
    buffer: number;
    available: number;
    flexibleBudgeted: number;
    essential: number;
    unallocated: number;
    cushion: number;
  } | null;
}) {
  const t = getDictionary(locale).payday;
  const [open, setOpen] = useState(shouldAutoOpen);

  if (draft.isEditingConfirmed) {
    const drafted = room ? null : summarizePaydayDraft(draft, rates);
    const figures = room ?? {
      income: drafted!.totalIncome,
      buffer: draft.plannedBuffer,
      available: drafted!.available,
      flexibleBudgeted: drafted!.flexibleTotal,
      essential: drafted!.essentialFixedTotal,
      unallocated: Math.max(0, drafted!.available - drafted!.flexibleTotal),
      cushion: drafted!.room.cushion,
    };
    const money = (amount: number) => formatMoney(amount, draft.displayCurrency);

    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t.wizardTitle(formatPeriodLong(draft.period, locale))}</CardTitle>
          <CardDescription>
            {t.summaryIncome}: {money(figures.income)} · {t.summaryBuffer}: {money(figures.buffer)} ·{" "}
            {t.summaryAvailable}: {money(figures.available)} · {t.flexibleAllocated}: {money(figures.flexibleBudgeted)}
            {figures.unallocated > 0 ? ` · ${t.flexibleUnallocated}: ${money(figures.unallocated)}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t.summaryCushion}: <span className="figure">{money(figures.cushion)}</span> - {t.summaryCushionHint}
          </p>
          {draft.incomeAdjustment ? (
            <p className="text-xs text-muted-foreground">
              {t.incomeAdjusted(formatMoney(draft.incomeAdjustment.by, draft.displayCurrency, { signDisplay: "always" }))}
            </p>
          ) : null}
          {draft.carryoverAdjustment ? (
            <p className="text-xs text-muted-foreground">
              {t.carryoverAdjusted(
                formatMoney(draft.carryoverAdjustment.by, draft.displayCurrency, { signDisplay: "always" }),
                formatPeriodLong(draft.carryoverAdjustment.from, locale),
              )}
            </p>
          ) : null}
          {figures.flexibleBudgeted === 0 && figures.essential === 0 ? (
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
