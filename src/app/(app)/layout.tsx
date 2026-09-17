import { AppShell } from "@/components/shell/app-shell";
import { LocaleProvider } from "@/components/shell/locale-provider";
import { requireAuth } from "@/lib/auth";
import { getAppContext } from "@/lib/data/context";
import { getInsights } from "@/lib/data/insights";

// Every page reads live data behind the PIN gate, so nothing is prerendered.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireAuth();
  // The nav's Inbox badge counts every current, non-dismissed insight from
  // every source (src/lib/insights.ts). getInsights is request-cached, so the
  // Inbox page reads the same run rather than detecting again - and the
  // Afford tracker inside it is the same request-cached getAffordRechecks the
  // Dashboard alert and the Recurring page's section read.
  const [context, insights] = await Promise.all([getAppContext(), getInsights()]);
  const navBadges = { "/inbox": insights.length };
  // The provider sits above error.tsx (which wraps this layout's children, not
  // the layout itself), so the error boundary still renders in the user's own
  // language when a page below it throws.
  return (
    <AppShell context={context} navBadges={navBadges}>
      <LocaleProvider locale={context.language}>{children}</LocaleProvider>
    </AppShell>
  );
}
