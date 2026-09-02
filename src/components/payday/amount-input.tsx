"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A money input that holds its own raw text while typing, so a decimal point
 * or a leading "-" survives a re-render. A plain controlled <Input value={n}>
 * strips them on every keystroke because the parsed number round-trips back
 * through the DOM before the user finishes typing it.
 *
 * Resyncs `text` from an external `value` change (e.g. the dialog reopening
 * with a fresh draft), but never from a change this input itself just caused
 * (tracked via lastEmitted, kept as state rather than a ref so the
 * render-time resync check below can read it without tripping
 * react-hooks/refs) - otherwise an intermediate unparseable value like a
 * lone "-" or "." would report 0 upward and immediately get overwritten back
 * to "0", making it impossible to type a negative number over a non-zero
 * seed.
 */
export function PaydayAmountInput({
  value,
  onChange,
  allowNegative = false,
  id,
  ariaLabel,
  className,
}: {
  value: number;
  onChange: (value: number) => void;
  allowNegative?: boolean;
  id?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const [text, setText] = useState(String(value));
  const [prevValue, setPrevValue] = useState(value);
  const [lastEmitted, setLastEmitted] = useState(value);

  if (value !== prevValue) {
    setPrevValue(value);
    if (value !== lastEmitted) {
      setText(String(value));
    }
  }

  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      inputMode="decimal"
      className={cn("font-mono text-right", className)}
      value={text}
      onChange={(event) => {
        const raw = event.target.value;
        const pattern = allowNegative ? /^-?[\d,]*\.?\d*$/ : /^[\d,]*\.?\d*$/;
        if (raw !== "" && !pattern.test(raw)) return;
        setText(raw);
        const parsed = Number(raw.replace(/,/g, ""));
        const next = Number.isFinite(parsed) ? parsed : 0;
        setLastEmitted(next);
        onChange(next);
      }}
    />
  );
}
