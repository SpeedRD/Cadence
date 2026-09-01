"use client";

import { useActionState, useEffect, useRef, useState } from "react";
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
  DialogTrigger,
} from "@/components/ui/dialog";

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
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [state, formAction, pending] = useActionState(action, null);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (state?.ok && state.at !== handled.current) {
      handled.current = state.at;
      setOpen(false);
      toast.success(state.message ?? savedMessage);
    }
  }, [state, setOpen, savedMessage]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className={size === "wide" ? "sm:max-w-lg" : undefined}>
        <form action={formAction} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? (
              <DialogDescription>{description}</DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="grid gap-4">{children}</div>

          {state?.error ? (
            <p className="text-sm text-destructive" role="alert">
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
