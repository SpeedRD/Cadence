"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { firstError, formObject, insightRefSchema } from "@/lib/validation";

import { dismissInsight, getInsights } from "@/lib/data/insights";

import { done, fail, revalidateApp, type ActionState } from "./utils";

/**
 * "Dismiss" on an Inbox insight: it never appears in the Inbox or counts
 * toward the nav badge again. The form carries only the insight's identity
 * (source + key); the row is written only for an insight that is current
 * right now, so a stale page cannot dismiss something that has since
 * resolved on its own - or anything that never existed.
 */
export async function dismissInsightAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).inbox;
  const parsed = insightRefSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const current = await getInsights();
  const insight = current.find(
    (row) => row.source === parsed.data.source && row.key === parsed.data.key,
  );
  if (!insight || !insight.dismissible) return fail(t.dismissUnknown);
  await dismissInsight(parsed.data);

  revalidateApp();
  return done(t.dismissed);
}
