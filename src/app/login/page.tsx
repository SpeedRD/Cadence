import { redirect } from "next/navigation";

import { PinGate } from "@/components/auth/pin-gate";
import { isAuthenticated, isPinConfigured, getSettings } from "@/lib/auth";
import { isLocale } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export const metadata = { title: "Unlock - Cadence" };

export default async function LoginPage() {
  if (await isAuthenticated()) redirect("/");
  const [configured, settings] = await Promise.all([
    isPinConfigured(),
    getSettings(),
  ]);
  const locale = isLocale(settings.language) ? settings.language : "en";
  return <PinGate mode={configured ? "login" : "create"} locale={locale} />;
}
