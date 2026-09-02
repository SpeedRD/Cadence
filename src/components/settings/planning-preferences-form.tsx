"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/form/field";
import { CurrencySelect } from "@/components/form/selects";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { getDictionary, type Locale } from "@/lib/i18n";
import { savePlanningPreferencesAction } from "@/server/actions/settings";

export function PlanningPreferencesForm({
  bufferPercent,
  bufferFloorAmount,
  bufferFloorCurrency,
  carryoverIncludedByDefault,
  locale,
}: {
  bufferPercent: number;
  bufferFloorAmount: number;
  bufferFloorCurrency: string;
  carryoverIncludedByDefault: boolean;
  locale: Locale;
}) {
  const t = getDictionary(locale).settingsPage;
  const common = getDictionary(locale).common;
  const [state, formAction, pending] = useActionState(savePlanningPreferencesAction, null);
  const [carryoverDefault, setCarryoverDefault] = useState(carryoverIncludedByDefault);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) toast.success(state.message ?? t.planningPreferencesSaved);
    else if (state.error) toast.error(state.error);
  }, [state, t.planningPreferencesSaved]);

  return (
    <form action={formAction} className="space-y-4">
      <input
        type="hidden"
        name="carryoverIncludedByDefault"
        value={carryoverDefault ? "true" : "false"}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.bufferPercentLabel} htmlFor="buffer-percent" hint={t.bufferPercentHint}>
          <Input
            id="buffer-percent"
            name="bufferPercent"
            type="number"
            min={0}
            max={100}
            defaultValue={bufferPercent}
          />
        </Field>
        <Field label={t.bufferFloorLabel} htmlFor="buffer-floor">
          <div className="flex gap-2">
            <Input
              id="buffer-floor"
              name="bufferFloorAmount"
              inputMode="decimal"
              className="font-mono"
              defaultValue={bufferFloorAmount}
            />
            <div className="w-24">
              <CurrencySelect name="bufferFloorCurrency" defaultValue={bufferFloorCurrency} />
            </div>
          </div>
        </Field>
      </div>

      <label className="flex items-center gap-2.5 text-sm">
        <Switch checked={carryoverDefault} onCheckedChange={setCarryoverDefault} />
        {t.carryoverDefaultLabel}
      </label>
      <p className="text-xs text-muted-foreground">{t.carryoverDefaultHint}</p>

      {state?.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton pending={pending} size="sm">
        {common.save}
      </SubmitButton>
    </form>
  );
}
