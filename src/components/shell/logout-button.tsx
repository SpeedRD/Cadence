"use client";

import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { logoutAction } from "@/server/actions/auth";

export function LogoutButton({ ariaLabel }: { ariaLabel: string }) {
  return (
    <form action={logoutAction}>
      <Button variant="ghost" size="icon-sm" type="submit" aria-label={ariaLabel}>
        <LogOut className="size-4" />
      </Button>
    </form>
  );
}
