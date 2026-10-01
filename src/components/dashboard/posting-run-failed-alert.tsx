import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { Dictionary } from "@/lib/i18n";

/**
 * The latest recurring posting run threw, so nothing was posted - the
 * posting_run_failed insight (src/lib/insights.ts), which is why it has no
 * per-item list the way NotPostingAlert does. Every request runs the
 * catch-up again, so this clears itself on the first run that succeeds. The
 * reason is on the Inbox; this only says it happened and where to look.
 */
export function PostingRunFailedAlert({ t }: { t: Dictionary["dashboard"] }) {
  return (
    <Alert className="border-[var(--warning)]/40">
      <AlertTitle>{t.postingRunFailedTitle}</AlertTitle>
      <AlertDescription>
        <p>{t.postingRunFailedDescription}</p>
        <Link href="/inbox" className="underline underline-offset-3 hover:text-foreground">
          {t.postingRunFailedLink}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
