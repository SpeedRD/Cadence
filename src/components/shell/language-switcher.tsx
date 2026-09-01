"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Locale } from "@/lib/i18n";
import { updateLanguageAction } from "@/server/actions/settings";
import { cn } from "@/lib/utils";

const LANGUAGES: { code: Locale; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
];

/** Sets the language every label and message in the app renders in. */
export function LanguageSwitcher({
  value,
  switcherLabel,
}: {
  value: Locale;
  switcherLabel: string;
}) {
  const [pending, startTransition] = useTransition();

  const select = (code: Locale) => {
    if (code === value) return;
    startTransition(async () => {
      const formData = new FormData();
      formData.set("language", code);
      const result = await updateLanguageAction(null, formData);
      if (result?.error) toast.error(result.error);
      else if (result?.message) toast.success(result.message);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" disabled={pending} className="font-mono">
          {value.toUpperCase()}
          <ChevronsUpDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuLabel>{switcherLabel}</DropdownMenuLabel>
        {LANGUAGES.map(({ code, label }) => (
          <DropdownMenuItem key={code} onSelect={() => select(code)}>
            <Check
              className={cn("size-3.5", code === value ? "opacity-100" : "opacity-0")}
            />
            <span className="font-mono">{code.toUpperCase()}</span>
            <span className="text-muted-foreground">{label}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
