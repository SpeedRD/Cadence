"use client";

import { useState } from "react";

import { ConversionPreview } from "@/components/form/conversion-preview";
import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { AccountSelect, type Option } from "@/components/form/selects";
import { markGoalAchieved } from "@/components/goals/goal-achieved";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { RateTable } from "@/lib/currency";
import { addContributionAction } from "@/server/actions/goals";

/**
 * Contributions are recorded in the goal's own currency; the money leaves the
 * chosen account as an expense in that account's currency.
 */
export function ContributionDialog({
  goalId,
  goalName,
  currency,
  accounts,
  defaultDate,
  rates,
  trigger,
  locale,
}: {
  goalId: string;
  goalName: string;
  currency: string;
  /** Active accounts only - a new row is never filed against an archived one. */
  accounts: Option[];
  defaultDate: string;
  /** The request's rate table, for the conversion preview. */
  rates: RateTable["rates"];
  trigger: React.ReactNode;
  locale: Locale;
}) {
  const t = getDictionary(locale).goals;
  const common = getDictionary(locale).common;
  // Tracked only for the conversion preview: the account's expense is stored
  // in its own currency, converted once at today's rate (K7).
  const [amountText, setAmountText] = useState("");
  const [accountId, setAccountId] = useState<string | undefined>(undefined);

  return (
    <FormDialog
      title={t.addTo(goalName)}
      description={t.contributionDialogDescription}
      action={addContributionAction}
      submitLabel={t.logContribution}
      cancelLabel={common.cancel}
      savedMessage={t.contributionLogged}
      trigger={trigger}
      onSuccess={(state) => {
        // Only ever set on the contribution that crossed the target.
        if (state.achievedGoalId) markGoalAchieved(state.achievedGoalId);
      }}
    >
      <input type="hidden" name="goalId" value={goalId} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t.amountWithCurrency(currency)} htmlFor="contribution-amount">
          <Input
            id="contribution-amount"
            name="amount"
            inputMode="decimal"
            className="font-mono"
            placeholder="0.00"
            onChange={(event) => setAmountText(event.target.value)}
            required
          />
        </Field>
        <Field label={common.date} htmlFor="contribution-date">
          <Input
            id="contribution-date"
            type="date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </Field>
      </div>

      {/* No default: which account the money leaves is an explicit choice,
          never the first one in the list. Required by contributionSchema. */}
      <Field label={common.account} htmlFor="contribution-account" hint={t.contributionAccountHint}>
        <AccountSelect
          id="contribution-account"
          name="accountId"
          accounts={accounts}
          common={common}
          onValueChange={setAccountId}
        />
      </Field>
      <ConversionPreview
        amount={amountText}
        currency={currency}
        accountCurrency={accounts.find((account) => account.id === accountId)?.currency}
        rates={rates}
        locale={locale}
      />

      <Field label={common.note} htmlFor="contribution-note">
        <Textarea
          id="contribution-note"
          name="note"
          rows={2}
          placeholder={common.optional}
        />
      </Field>
    </FormDialog>
  );
}
