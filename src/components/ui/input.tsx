import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 sm:h-8 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        // iOS WebKit's theme (RenderThemeIOS/RenderThemeCocoa
        // adjustInputElementButtonStyle) overrides the cascade for date
        // inputs: unless `width` is a fixed length, it forces
        // box-sizing: content-box and a min-width of the widest localized
        // date. With w-full that makes the box 100% of its container *plus*
        // padding and border (~22px wider, ~10px taller than its siblings),
        // which opens a horizontal scroll on the dialog sheet. A fixed 1px
        // width is the theme's own opt-out (it then leaves box-sizing and
        // min-width to the author), and min-w-full stretches the box back
        // to exactly its container, border included.
        // Callers resizing a date input should use min-w-*, or a fixed
        // width, never a percentage width, or the override comes back.
        type === "date" && "w-px min-w-full",
        className
      )}
      {...props}
    />
  )
}

export { Input }
