import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// text-hint and text-badge are font sizes (globals.css). Unregistered, twMerge
// reads any unknown text-* as a colour and drops it beside text-muted-foreground.
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["hint", "badge"] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
