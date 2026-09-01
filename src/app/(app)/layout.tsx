import { AppShell } from "@/components/shell/app-shell";
import { requireAuth } from "@/lib/auth";
import { getAppContext } from "@/lib/data/context";

// Every page reads live data behind the PIN gate, so nothing is prerendered.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  await requireAuth();
  const context = await getAppContext();
  return <AppShell context={context}>{children}</AppShell>;
}
