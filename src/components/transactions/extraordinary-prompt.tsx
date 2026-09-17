"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMoney } from "@/lib/currency";
import { getDictionary, type Locale } from "@/lib/i18n";
import { setExtraordinaryAction } from "@/server/actions/transactions";

import type { ExtraordinarySuggestion } from "@/server/actions/utils";

/**
 * The question the transaction form asks right after saving an expense that
 * is unusually large for its category (ActionState.extraordinarySuggestion).
 * The row is already saved, unflagged; only "yes" writes anything. Closing
 * the dialog any other way is the same as "no" - the default is always
 * normal spending, never the reverse.
 */
export function ExtraordinaryPrompt({
  suggestion,
  onCloseAction,
  locale,
}: {
  suggestion: ExtraordinarySuggestion | null;
  onCloseAction: () => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).transactions;
  const [state, formAction, pending] = useActionState(setExtraordinaryAction, null);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) {
      toast.success(state.message ?? t.markedExtraordinary);
      onCloseAction();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, onCloseAction, t.markedExtraordinary]);

  return (
    <Dialog open={suggestion !== null} onOpenChange={(open) => !open && onCloseAction()}>
      <DialogContent className="sm:max-w-sm">
        {suggestion ? (
          <form action={formAction} className="grid gap-5">
            <input type="hidden" name="id" value={suggestion.transactionId} />
            <input type="hidden" name="isExtraordinary" value="true" />
            <DialogHeader>
              <DialogTitle>{t.extraordinaryPromptTitle}</DialogTitle>
              <DialogDescription>
                {t.extraordinaryPromptDescription(
                  formatMoney(suggestion.amount, suggestion.currency),
                  suggestion.categoryName,
                  formatMoney(suggestion.median, suggestion.medianCurrency),
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onCloseAction}>
                {t.extraordinaryNo}
              </Button>
              <SubmitButton pending={pending}>{t.extraordinaryYes}</SubmitButton>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
