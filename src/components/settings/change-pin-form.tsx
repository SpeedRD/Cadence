"use client";

import { useActionState, useEffect, useRef } from "react";
import { toast } from "sonner";

import { Field } from "@/components/form/field";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { getDictionary, type Locale } from "@/lib/i18n";
import { changePinAction } from "@/server/actions/auth";

/**
 * Settings-page PIN change: current PIN, new PIN, confirmation. Unlike the
 * other settings forms this one resets on success so the digits never sit in
 * the fields after they have been used.
 */
export function ChangePinForm({ locale }: { locale: Locale }) {
  const t = getDictionary(locale).settingsPage;
  const login = getDictionary(locale).login;
  const [state, formAction, pending] = useActionState(changePinAction, null);
  const formRef = useRef<HTMLFormElement>(null);
  const handled = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!state || state.at === handled.current) return;
    handled.current = state.at;
    if (state.ok) {
      toast.success(state.message ?? t.pinChanged);
      formRef.current?.reset();
    }
  }, [state, t.pinChanged]);

  const pinInput = (id: string, name: string, autoComplete: string) => (
    <Input
      id={id}
      name={name}
      type="password"
      inputMode="numeric"
      autoComplete={autoComplete}
      pattern="[0-9]{4,6}"
      minLength={4}
      maxLength={6}
      className="font-mono tracking-[0.3em]"
      required
    />
  );

  return (
    <form ref={formRef} action={formAction} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t.currentPin} htmlFor="pin-current">
          {pinInput("pin-current", "currentPin", "current-password")}
        </Field>
        <Field label={t.newPin} htmlFor="pin-new">
          {pinInput("pin-new", "pin", "new-password")}
        </Field>
        <Field label={t.confirmNewPin} htmlFor="pin-confirm" hint={login.digitsHint}>
          {pinInput("pin-confirm", "confirm", "new-password")}
        </Field>
      </div>

      {state?.error ? (
        <p className="text-sm text-destructive" role="alert">
          {state.error}
        </p>
      ) : null}

      <SubmitButton pending={pending} size="sm">
        {t.changePin}
      </SubmitButton>
    </form>
  );
}
