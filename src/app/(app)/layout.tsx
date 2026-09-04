import { AppShell } from "@/components/shell/app-shell";
import { LocaleProvider } from "@/components/shell/locale-provider";
import { requireAuth } from "@/lib/auth";
import { getAppContext } from "@/lib/data/context";

// Every page reads live data behind the PIN gate, so nothing is prerendered.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireAuth();
  const context = await getAppContext();
  // The provider sits above error.tsx (which wraps this layout's children, not
  // the layout itself), so the error boundary still renders in the user's own
  // language when a page below it throws.
  return (
    <AppShell context={context}>
      <LocaleProvider locale={context.language}>{children}</LocaleProvider>
    </AppShell>
  );
}
