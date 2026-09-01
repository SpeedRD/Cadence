import { redirect } from "next/navigation";

import { PinGate } from "@/components/auth/pin-gate";
import { isAuthenticated, isPinConfigured } from "@/lib/auth";

export const dynamic = "force-dynamic";

export const metadata = { title: "Unlock - Cadence" };

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/");
  const configured = await isPinConfigured();
  return <PinGate mode={configured ? "login" : "create"} />;
}
