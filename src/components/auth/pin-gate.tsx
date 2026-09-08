"use client";

import { useActionState, useRef, useState } from "react";

import { SubmitButton } from "@/components/form/submit-button";
import { PeriodRail } from "@/components/period-rail";
import { createPinAction, loginAction, recoverPinAction } from "@/server/actions/auth";
import { getDictionary, type Locale } from "@/lib/i18n";
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

type GateView = "create" | "login" | "recover";

const ACTIONS = {
  create: createPinAction,
  login: loginAction,
  recover: recoverPinAction,
} as const;

export function PinGate({
  mode,
  recoveryConfigured,
  locale,
}: {
  mode: "create" | "login";
  /** Whether RECOVERY_SECRET is set server-side; the "Forgot your PIN?" path only shows when it is. */
  recoveryConfigured: boolean;
  locale: Locale;
}) {
  const t = getDictionary(locale).login;
  const [view, setView] = useState<GateView>(mode);

  const subtitle =
    view === "create" ? t.createSubtitle : view === "recover" ? t.recoverSubtitle : t.loginSubtitle;

  return (
    <main className="flex min-h-dvh items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-10 space-y-4">
          <PeriodRail totalDays={16} elapsed={9} compact className="w-28" />
          <div className="space-y-1.5">
            <h1 className="text-3xl font-semibold">Cadence</h1>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          </div>
        </div>

        {/* Keyed by view so each form owns a fresh action state and empty
            fields: digits typed into the unlock form never carry into the
            recovery form and vice versa. */}
        <GateForm
          key={view}
          view={view}
          locale={locale}
          footer={
            view === "login" && recoveryConfigured ? (
              <button
                type="button"
                onClick={() => setView("recover")}
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                {t.forgotPin}
              </button>
            ) : view === "recover" ? (
              <button
                type="button"
                onClick={() => setView("login")}
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                {t.backToUnlock}
              </button>
            ) : null
          }
        />
      </div>
    </main>
  );
}

function GateForm({
  view,
  locale,
  footer,
}: {
  view: GateView;
  locale: Locale;
  footer: React.ReactNode;
}) {
  const t = getDictionary(locale).login;
  const [state, formAction, pending] = useActionState(ACTIONS[view], null);
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [secret, setSecret] = useState("");
  const needsConfirm = view !== "login";

  const ready =
    pin.length >= MIN_DIGITS &&
    (!needsConfirm || confirm.length >= MIN_DIGITS) &&
    (view !== "recover" || secret.length > 0);

  const pinLabel = view === "login" ? t.pin : t.newPin;
  const submitLabel =
    view === "create" ? t.setPinAndContinue : view === "recover" ? t.setNewPin : t.unlock;

  return (
    <form action={formAction} className="space-y-5">
      {view === "recover" ? (
        <div className="space-y-2">
          <label htmlFor="recovery-secret" className="eyebrow block">
            {t.recoverySecret}
          </label>
          <input
            id="recovery-secret"
            name="secret"
            type="password"
            autoComplete="off"
            autoFocus
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            className="h-12 w-full rounded-md border border-border bg-card px-3 font-mono text-sm outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/40"
          />
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="eyebrow">{pinLabel}</p>
        <PinInput
          name="pin"
          label={pinLabel}
          value={pin}
          onChange={setPin}
          autoFocus={view !== "recover"}
        />
      </div>

      {needsConfirm ? (
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
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">{t.digitsHint}</p>
          {footer}
        </div>
        <SubmitButton pending={pending} className={cn(!ready && "opacity-60")}>
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}
