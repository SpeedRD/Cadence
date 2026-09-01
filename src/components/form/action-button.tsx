"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { SubmitButton } from "@/components/form/submit-button";

import type { ActionState } from "@/server/actions/utils";

/** A single-button form for actions that need no input beyond hidden fields. */
export function ActionButton({
  action,
  children,
  fields,
  variant = "outline",
  size,
  className,
}: {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  children: React.ReactNode;
  fields?: Record<string, string | number>;
  variant?: React.ComponentProps<typeof SubmitButton>["variant"];
  size?: React.ComponentProps<typeof SubmitButton>["size"];
  className?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) toast.success(state.message ?? "Done");
    else if (state.error) toast.error(state.error);
  }, [state]);

  return (
    <form action={formAction} className={className}>
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={String(value)} />
      ))}
      <SubmitButton pending={pending} variant={variant} size={size}>
        {children}
      </SubmitButton>
    </form>
  );
}
