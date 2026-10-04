"use client";

import { useEffect, useRef, useState } from "react";

import { ConversionPreview } from "@/components/form/conversion-preview";
import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { AccountSelect, type Option } from "@/components/form/selects";
import { markGoalAchieved } from "@/components/goals/goal-achieved";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { fromISODate } from "@/lib/date";
import { formatDate } from "@/lib/date-format";
import { getDictionary, type Locale } from "@/lib/i18n";
import type { RateTable } from "@/lib/currency";
import { addContributionAction, previewContributionSettlesAction } from "@/server/actions/goals";

const SETTLES_CHECK_DEBOUNCE_MS = 400;

/**
 * The automatic contribution a hand-logged one would count as (posting
 * pairs a contribution of its amount, to the same goal, near its due date -
 * B16), asked of the server as the fields change: its due date, or null.
 * Said before saving, so it is never a surprise. The last answer stays while
 * a new one is in flight; one for inputs that have since changed is dropped.
 * `target` names the goal being logged to, or the contribution being edited.
 * Asked only while the dialog is `open`, afresh each time it opens.
 */
export function useAutomaticContributionNotice(
  target: { goalId: string } | { contributionId: string },
  fields: { open: boolean; amount: string; accountId: string | undefined; date: string },
): { dueDate: Date | null; reset: () => void } {
  const [settlesOn, setSettlesOn] = useState<string | null>(null);
  const settlesRequest = useRef(0);
  const { open, amount, accountId, date } = fields;
  const goalId = "goalId" in target ? target.goalId : undefined;
  const contributionId = "contributionId" in target ? target.contributionId : undefined;
  const shouldCheck = open && amount.trim() !== "" && Boolean(accountId) && fromISODate(date) !== null;
  useEffect(() => {
    if (!shouldCheck) return;
    const request = (settlesRequest.current += 1);
    const timer = setTimeout(async () => {
      let next: string | null = null;
      try {
        const result = await previewContributionSettlesAction({ goalId, contributionId, accountId, amount, date });
        if (result.ok) next = result.dueDate;
      } catch {
        // Advisory only: a failed check shows nothing.
      }
      if (request === settlesRequest.current) setSettlesOn(next);
    }, SETTLES_CHECK_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      settlesRequest.current += 1;
    };
  }, [shouldCheck, goalId, contributionId, accountId, amount, date]);
  return { dueDate: shouldCheck && settlesOn ? fromISODate(settlesOn) : null, reset: () => setSettlesOn(null) };
}

/** The notice itself: "This will count as the automatic contribution due <date>", when there is one. */
export function AutomaticContributionNotice({ dueDate, locale }: { dueDate: Date | null; locale: Locale }) {
  if (!dueDate) return null;
  return (
    <p className="text-xs text-muted-foreground" aria-live="polite" data-contribution-settles>
      {getDictionary(locale).goals.contributionCountsAsAutomatic(formatDate(dueDate, locale))}
    </p>
  );
}

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
  const [dateText, setDateText] = useState(defaultDate);
  // This component outlives each opening (only the dialog's content
  // remounts, with empty fields): what it tracks starts over with them.
  const [open, setOpen] = useState(false);
  const settles = useAutomaticContributionNotice({ goalId }, { open, amount: amountText, accountId, date: dateText });
  const changeOpen = (next: boolean) => {
    if (next) {
      setAmountText("");
      setAccountId(undefined);
      setDateText(defaultDate);
      settles.reset();
    }
    setOpen(next);
  };

  return (
    <FormDialog
      title={t.addTo(goalName)}
      description={t.contributionDialogDescription}
      action={addContributionAction}
      submitLabel={t.logContribution}
      cancelLabel={common.cancel}
      savedMessage={t.contributionLogged}
      trigger={trigger}
      open={open}
      onOpenChange={changeOpen}
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
            onChange={(event) => setDateText(event.target.value)}
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
      <AutomaticContributionNotice dueDate={settles.dueDate} locale={locale} />

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
