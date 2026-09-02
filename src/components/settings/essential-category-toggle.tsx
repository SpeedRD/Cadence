"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Switch } from "@/components/ui/switch";
import { toggleEssentialCategoryAction } from "@/server/actions/settings";

export function EssentialCategoryToggle({
  categoryId,
  initialValue,
  ariaLabel,
  errorMessage,
}: {
  categoryId: string;
  initialValue: boolean;
  ariaLabel: string;
  errorMessage: string;
}) {
  const [checked, setChecked] = useState(initialValue);
  const [pending, startTransition] = useTransition();

  return (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={pending}
      onCheckedChange={(next) => {
        setChecked(next);
        startTransition(async () => {
          const form = new FormData();
          form.set("categoryId", categoryId);
          form.set("isEssentialFixed", next ? "true" : "false");
          const result = await toggleEssentialCategoryAction(null, form);
          if (result?.error) {
            setChecked(!next);
            toast.error(result.error || errorMessage);
          }
        });
      }}
    />
  );
}
