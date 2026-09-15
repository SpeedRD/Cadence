import { AppShell } from "@/components/shell/app-shell";
import { LocaleProvider } from "@/components/shell/locale-provider";
import { notViableAffordItems } from "@/lib/afford-tracking";
import { requireAuth } from "@/lib/auth";
import { getAffordRechecks } from "@/lib/data/afford";
import { getAppContext } from "@/lib/data/context";

// Every page reads live data behind the PIN gate, so nothing is prerendered.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireAuth();
  // The nav's Recurring badge counts the plans recorded from Afford whose
  // remaining payments no longer fit today's projections. getAffordRechecks is
  // request-cached, so the Dashboard alert and the Recurring page's section
  // read the same run rather than projecting again.
  const [context, affordRechecks] = await Promise.all([getAppContext(), getAffordRechecks()]);
  const navBadges = { "/recurring": notViableAffordItems(affordRechecks).length };
  // The provider sits above error.tsx (which wraps this layout's children, not
  // the layout itself), so the error boundary still renders in the user's own
  // language when a page below it throws.
  return (
    <AppShell context={context} navBadges={navBadges}>
      <LocaleProvider locale={context.language}>{children}</LocaleProvider>
    </AppShell>
  );
}
