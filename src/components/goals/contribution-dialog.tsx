"use client";

import { Field } from "@/components/form/field";
import { FormDialog } from "@/components/form/form-dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { addContributionAction } from "@/server/actions/goals";

/** Contributions are recorded in the goal's own currency. */
export function ContributionDialog({
  goalId,
  goalName,
  currency,
  defaultDate,
  trigger,
}: {
  goalId: string;
  goalName: string;
  currency: string;
  defaultDate: string;
  trigger: React.ReactNode;
}) {
  return (
    <FormDialog
      title={`Add to ${goalName}`}
      description="Contributions are the source of truth for goal progress."
      action={addContributionAction}
      submitLabel="Log contribution"
      trigger={trigger}
    >
      <input type="hidden" name="goalId" value={goalId} />

      <div className="grid grid-cols-2 gap-3">
        <Field label={`Amount (${currency})`} htmlFor="contribution-amount">
          <Input
            id="contribution-amount"
            name="amount"
            inputMode="decimal"
            className="font-mono"
            placeholder="0.00"
            required
          />
        </Field>
        <Field label="Date" htmlFor="contribution-date">
          <Input
            id="contribution-date"
            type="date"
            name="date"
            defaultValue={defaultDate}
            required
          />
        </Field>
      </div>

      <Field label="Note" htmlFor="contribution-note">
        <Textarea
          id="contribution-note"
          name="note"
          rows={2}
          placeholder="Optional"
        />
      </Field>
    </FormDialog>
  );
}
