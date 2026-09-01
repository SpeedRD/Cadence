"use client";

import { useActionState, useRef, useState } from "react";

import { SubmitButton } from "@/components/form/submit-button";
import { PeriodRail } from "@/components/period-rail";
import { createPinAction, loginAction } from "@/server/actions/auth";
import type { Dictionary } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const MAX_DIGITS = 6;
const MIN_DIGITS = 4;

function PinInput({
  name,
  label,
  value,
  onChange,
  autoFocus,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);

  return (
    <div className="relative">
      <input
        ref={inputRef}
        name={name}
        value={value}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        autoFocus={autoFocus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) =>
          onChange(event.target.value.replace(/\D/g, "").slice(0, MAX_DIGITS))
        }
        className="absolute inset-0 z-10 h-full w-full cursor-text opacity-0"
      />
      <div className="flex gap-1.5" aria-hidden="true">
        {Array.from({ length: MAX_DIGITS }, (_, index) => {
          const filled = index < value.length;
          const isNext = focused && index === value.length;
          return (
            <span
              key={index}
              className={cn(
                "flex h-12 flex-1 items-center justify-center rounded-md border bg-card transition-colors",
                filled ? "border-primary/50" : "border-border",
                isNext && "border-primary ring-3 ring-ring/40",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full transition-opacity",
                  filled ? "bg-primary opacity-100" : "bg-foreground opacity-0",
                )}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function PinGate({
  mode,
  t,
}: {
  mode: "create" | "login";
  t: Dictionary["login"];
}) {
  const [state, formAction, pending] = useActionState(
    mode === "create" ? createPinAction : loginAction,
    null,
  );
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");

  const ready =
    pin.length >= MIN_DIGITS &&
    (mode === "login" || confirm.length >= MIN_DIGITS);

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-10 space-y-4">
          <PeriodRail totalDays={16} elapsed={9} compact className="w-28" />
          <div className="space-y-1.5">
            <h1 className="text-3xl font-semibold">Cadence</h1>
            <p className="text-sm text-muted-foreground">
              {mode === "create" ? t.createSubtitle : t.loginSubtitle}
            </p>
          </div>
        </div>

        <form action={formAction} className="space-y-5">
          <div className="space-y-2">
            <p className="eyebrow">{mode === "create" ? t.newPin : t.pin}</p>
            <PinInput
              name="pin"
              label={mode === "create" ? t.newPin : t.pin}
              value={pin}
              onChange={setPin}
              autoFocus
            />
          </div>

          {mode === "create" ? (
            <div className="space-y-2">
              <p className="eyebrow">{t.confirm}</p>
              <PinInput
                name="confirm"
                label={t.confirmPinAria}
                value={confirm}
                onChange={setConfirm}
              />
            </div>
          ) : null}

          {state?.error ? (
            <p className="text-sm text-destructive" role="alert">
              {state.error}
            </p>
          ) : null}

          <div className="flex items-center justify-between gap-4 pt-1">
            <p className="text-xs text-muted-foreground">{t.digitsHint}</p>
            <SubmitButton pending={pending} className={cn(!ready && "opacity-60")}>
              {mode === "create" ? t.setPinAndContinue : t.unlock}
            </SubmitButton>
          </div>
        </form>
      </div>
    </main>
  );
}
