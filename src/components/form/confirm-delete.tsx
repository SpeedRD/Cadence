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

export function ConfirmDelete({
  id,
  action,
  title,
  description,
  trigger,
  confirmLabel,
  keepLabel,
  deletedMessage,
  open: controlledOpen,
  onOpenChange,
}: {
  id: string;
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  title: string;
  description: string;
  trigger?: React.ReactNode;
  confirmLabel: string;
  keepLabel: string;
  deletedMessage: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
      toast.success(state.message ?? deletedMessage);
    }
  }, [state, setOpen, deletedMessage]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="sm:max-w-sm">
        <form action={formAction} className="grid gap-5">
          <input type="hidden" name="id" value={id} />
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          {state?.error ? (
            <p className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {keepLabel}
            </Button>
            <SubmitButton pending={pending} variant="destructive">
              {confirmLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
