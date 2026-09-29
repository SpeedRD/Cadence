"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/form/submit-button";
import { PostedMatchNotice } from "@/components/transactions/posted-match-notice";
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
import { keepPostedChargeAction } from "@/server/actions/transactions";

import type { PostedMatchSuggestion } from "@/server/actions/utils";

/**
 * The question the transaction form asks right after saving an entry that
 * matches a row Cadence wrote itself - a posted recurring charge or a
 * check-in's paycheck (ActionState.postedMatchSuggestion). The entry is
 * already saved; only "It's the posted charge" writes anything, keeping the
 * posted row and removing that entry - by the id and saved state the save
 * returned (keepPostedChargeAction). Closing the dialog any other way is the
 * same as "It's a different charge" - both rows stay, exactly as saved.
 */
export function PostedMatchPrompt({
  suggestion,
  onCloseAction,
  onKeptAction,
  locale,
}: {
  suggestion: PostedMatchSuggestion | null;
  onCloseAction: () => void;
  /** The entry is gone: anything else the form meant to ask about it is moot. */
  onKeptAction: () => void;
  locale: Locale;
}) {
  const t = getDictionary(locale).transactions;
  const [state, formAction, pending] = useActionState(keepPostedChargeAction, null);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) {
      toast.success(state.message ?? t.postedChargeKept);
      onKeptAction();
    } else if (state.error) {
      toast.error(state.error);
    }
  }, [state, onKeptAction, t.postedChargeKept]);

  const paycheck = suggestion?.match.kind === "paycheck";

  return (
    <Dialog open={suggestion !== null} onOpenChange={(open) => !open && onCloseAction()}>
      <DialogContent className="sm:max-w-sm">
        {suggestion ? (
          <form action={formAction} className="grid gap-5">
            <input type="hidden" name="id" value={suggestion.transactionId} />
            <input type="hidden" name="savedDigest" value={suggestion.savedDigest} />
            <input type="hidden" name="postedId" value={suggestion.match.posted.id} />
            <DialogHeader>
              <DialogTitle>{paycheck ? t.paycheckPromptTitle : t.postedPromptTitle}</DialogTitle>
              <DialogDescription asChild>
                <div className="grid gap-2">
                  <PostedMatchNotice
                    match={suggestion.match}
                    incoming={{ amount: suggestion.amount, currency: suggestion.currency }}
                    showOutcome
                    locale={locale}
                  />
                  <span>
                    {(paycheck ? t.paycheckPromptDescription : t.postedPromptDescription)(
                      formatMoney(suggestion.amount, suggestion.currency),
                      formatMoney(suggestion.match.posted.amount, suggestion.match.posted.currency),
                    )}
                  </span>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onCloseAction}>
                {t.isDifferentCharge}
              </Button>
              <SubmitButton pending={pending}>{paycheck ? t.isRecordedPaycheck : t.isPostedCharge}</SubmitButton>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
