"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Built to sit next to Switch: the same ring, the same focus treatment as
 * Button, and the same invisible hit padding, so a checkbox reads as part of
 * this app's form vocabulary rather than as the operating system's default.
 * A checkbox and not a switch on purpose - these mark "I understand", which is
 * a statement being made, not a setting being flipped.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer group/checkbox relative inline-flex size-4 shrink-0 items-center justify-center rounded-[min(var(--radius-md),6px)] border border-transparent ring-1 ring-foreground/10 transition-[color,background-color,box-shadow] outline-none",
        // Same 10px-ish hit padding Switch gives itself: the target is bigger
        // than the box without the box getting bigger.
        "after:absolute after:-inset-2",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        "data-unchecked:bg-input dark:data-unchecked:bg-input/80",
        "data-checked:bg-primary data-checked:text-primary-foreground data-checked:ring-transparent",
        "data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3 stroke-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
