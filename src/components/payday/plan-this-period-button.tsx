"use client";

import { useState } from "react";

import { PaydayCheckinDialog } from "@/components/payday/payday-checkin-dialog";
import { Button } from "@/components/ui/button";
import type { RateTable } from "@/lib/currency";
import type { PaydayCheckinDraft } from "@/lib/data/payday";
import { getDictionary, type Locale } from "@/lib/i18n";

export function PlanThisPeriodButton({
  draft,
  rates,
  locale,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
}) {
  const t = getDictionary(locale).payday;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t.planThisPeriod}
      </Button>
      <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
    </>
  );
}
