"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

import { Button } from "@/components/ui/button";

/**
 * Both icons render and CSS picks one from the `dark` class on <html>, so the
 * button is correct on the server too - no mounted flag, no hydration flash.
 */
export function ThemeToggle({ ariaLabel }: { ariaLabel: string }) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={ariaLabel}
      onClick={() => setTheme(resolvedTheme === "light" ? "dark" : "light")}
    >
      <Moon className="hidden size-4 dark:block" />
      <Sun className="size-4 dark:hidden" />
    </Button>
  );
}
