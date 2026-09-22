import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        // Mobile Safari's native date-and-time control can paint a few px
        // wider than the box its (already-correct) width: 100%/min-width: 0
        // resolve to - Chromium and desktop Safari always honour that width,
        // so this never shows up there. overflow-hidden clips that stray
        // sliver locally, at the field, instead of letting it bubble up into
        // DialogContent's scroll container (forced to overflow-x: auto by its
        // own overflow-y-auto) and open a small horizontal scroll on the
        // whole sheet. The picker itself is untouched - only paint that
        // exceeds the box is clipped, never its native appearance.
        type === "date" && "overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

export { Input }
