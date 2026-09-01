"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/form/submit-button";
import { CurrencySelect } from "@/components/form/selects";
import { getDictionary, type Locale } from "@/lib/i18n";
import { updateDisplayCurrencyAction } from "@/server/actions/settings";

export function DisplayCurrencyForm({
  value,
  locale,
}: {
  value: string;
  locale: Locale;
}) {
  const common = getDictionary(locale).common;
  const [state, formAction, pending] = useActionState(
    updateDisplayCurrencyAction,
    null,
  );
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) toast.success(state.message ?? common.saved);
    else if (state.error) toast.error(state.error);
  }, [state, common.saved]);

  return (
    <form action={formAction} className="flex items-end gap-2">
      <div className="w-32">
        <CurrencySelect name="displayCurrency" defaultValue={value} />
      </div>
      <SubmitButton pending={pending} variant="outline">
        {common.save}
      </SubmitButton>
    </form>
  );
}
