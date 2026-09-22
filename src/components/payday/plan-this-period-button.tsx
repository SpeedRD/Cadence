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
  label,
  variant = "outline",
  size = "sm",
  className,
}: {
  draft: PaydayCheckinDraft;
  rates: RateTable;
  locale: Locale;
  /** Defaults to "Plan this period"; the Budgets page passes the wording for a past or already confirmed period. */
  label?: string;
  /** The Budgets page docks a primary, full-width copy on a phone (MobileActionDock). */
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
}) {
  const t = getDictionary(locale).payday;
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setOpen(true)}>
        {label ?? t.planThisPeriod}
      </Button>
      <PaydayCheckinDialog draft={draft} rates={rates} locale={locale} open={open} onOpenChange={setOpen} />
    </>
  );
}
