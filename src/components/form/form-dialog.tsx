"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/form/submit-button";
import { useSubmitWithoutReset } from "@/components/form/use-submit-without-reset";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { revealScrollDelta } from "@/lib/reveal";

import type { ActionState } from "@/server/actions/utils";

type Action = (
  state: ActionState,
  formData: FormData,
) => Promise<ActionState>;

/**
 * Dialog + server action + pending state. The dialog closes and toasts on
 * success; the error comes back inline so the entered values survive.
 */
export function FormDialog({
  title,
  description,
  trigger,
  action,
  submitLabel,
  cancelLabel,
  children,
  size = "default",
  open: controlledOpen,
  onOpenChange,
  savedMessage,
  onSuccess,
}: {
  title: string;
  description?: string;
  trigger?: React.ReactNode;
  action: Action;
  submitLabel: string;
  cancelLabel: string;
  children: React.ReactNode;
  size?: "default" | "wide";
  /** Controlled mode, for a single dialog shared by many table rows. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  savedMessage: string;
  /** Runs once per successful submit, after the dialog closes and toasts. */
  onSuccess?: (state: NonNullable<ActionState>) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [state, formAction, pending] = useActionState(action, null);
  const submit = useSubmitWithoutReset(formAction);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (state?.ok && state.at !== handled.current) {
      handled.current = state.at;
      setOpen(false);
      toast.success(state.message ?? savedMessage);
      onSuccess?.(state);
    }
  }, [state, setOpen, savedMessage, onSuccess]);

  // On a phone the error line sits right above DialogFooter, which is
  // sticky over the sheet's bottom edge, so after Save it would land under
  // the footer. Each new result scrolls the sheet just enough to show it
  // above the footer; focus stays where it was, and an error already in
  // view does not move. Above sm the footer is not sticky: no change there.
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const error = errorRef.current;
    if (!error || !window.matchMedia("(width < 40rem)").matches) return;
    const scroller = error.closest<HTMLElement>("[data-slot=dialog-content]");
    if (!scroller) return;
    const footer = error.closest("form")?.querySelector("[data-slot=dialog-footer]");
    const delta = revealScrollDelta(scroller.getBoundingClientRect(), error.getBoundingClientRect(), {
      bottom: footer?.getBoundingClientRect().height ?? 0,
    });
    if (delta === 0) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollBy({ top: delta, behavior: reduceMotion ? "auto" : "smooth" });
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className={size === "wide" ? "sm:max-w-lg" : undefined}>
        <form action={formAction} onSubmit={submit} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="grid gap-4">{children}</div>

          {state?.error ? (
            <p ref={errorRef} className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {cancelLabel}
            </Button>
            <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
