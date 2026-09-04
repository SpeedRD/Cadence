import Link from "next/link";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { fromISODate, formatDayMonth } from "@/lib/date";
import type { Dictionary } from "@/lib/i18n";

import type {
  RecurringPostingSummary,
  RecurringSkipReason,
} from "@/lib/recurring-posting";

/**
 * The recurring items automatic posting could not process. They are never
 * advanced, so they stay out of "committed", out of the upcoming list and out
 * of the payday check-in while quietly staying due - previously the only trace
 * was a line in the server log. Every request's catch-up run re-reports them,
 * so this clears itself the moment the item is fixed.
 */
export function NotPostingAlert({
  posting,
  t,
}: {
  posting: RecurringPostingSummary;
  t: Dictionary["dashboard"];
}) {
  const reasonText: Record<RecurringSkipReason, string> = {
    missing_account: t.notPostingReasonMissingAccount,
    missing_goal: t.notPostingReasonMissingGoal,
    missing_account_and_goal: t.notPostingReasonMissingAccountAndGoal,
    account_archived: t.notPostingReasonAccountArchived,
  };

  const lines = [
    ...posting.skipped.map((item) => {
      const due = fromISODate(item.nextDate);
      return {
        id: item.id,
        text: t.notPostingItem(
          item.name,
          reasonText[item.reason],
          due ? formatDayMonth(due) : item.nextDate,
        ),
      };
    }),
    ...posting.failed.map((item) => ({
      id: item.id,
      text: `${item.name} - ${t.notPostingReasonFailed}: ${item.error}`,
    })),
  ];
  if (lines.length === 0) return null;

  return (
    <Alert className="border-[var(--warning)]/40">
      <AlertTitle>{t.notPostingTitle(lines.length)}</AlertTitle>
      <AlertDescription>
        <p>{t.notPostingDescription}</p>
        <ul className="list-disc space-y-0.5 pl-4">
          {lines.map((line) => (
            <li key={line.id}>{line.text}</li>
          ))}
        </ul>
        <Link
          href="/recurring"
          className="underline underline-offset-3 hover:text-foreground"
        >
          {t.notPostingLink}
        </Link>
      </AlertDescription>
    </Alert>
  );
}
