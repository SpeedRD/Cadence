"use client";

import { useState } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * A money input that holds its own raw text while typing, so a decimal point
 * or a leading "-" survives a re-render. A plain controlled <Input value={n}>
 * strips them on every keystroke because the parsed number round-trips back
 * through the DOM before the user finishes typing it.
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

  // If `value` changed from outside this input (not as an echo of what the
  // user just typed here - e.g. the dialog re-seeding on open, or another
  // control recomputing this amount), resync the displayed text. Adjusting
  // state during render (rather than in an effect) avoids an extra committed
  // render with stale text - see
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    const parsed = Number(text.replace(/,/g, ""));
    if (!Number.isFinite(parsed) || parsed !== value) {
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
        onChange(Number.isFinite(parsed) ? parsed : 0);
      }}
    />
  );
}
