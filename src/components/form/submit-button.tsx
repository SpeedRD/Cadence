"use client";

import { LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SubmitButton({
  children,
  pending,
  disabled,
  className,
  variant,
  size,
}: {
  children: React.ReactNode;
  pending: boolean;
  disabled?: boolean;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  return (
    <Button
      type="submit"
      disabled={pending || disabled}
      variant={variant}
      size={size}
      className={cn(className)}
    >
      {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
      {children}
    </Button>
  );
}
