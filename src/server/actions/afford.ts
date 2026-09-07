"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { num } from "@/lib/money";
import { affordInputSchema, firstError } from "@/lib/validation";

import {
  confirmAffordPurchase,
  evaluateAffordRequest,
  type AffordContext,
  type AffordRecordedPlan,
} from "@/lib/data/afford";
import { getAppContext } from "@/lib/data/context";

import type { AffordVerdict } from "@/lib/afford";

import { revalidateApp } from "./utils";

export type AffordEvaluateResult =
  | { ok: true; verdict: AffordVerdict; recorded: AffordRecordedPlan }
  | { ok: false; error: string };

export type AffordConfirmResult =
  | { ok: true; message: string; recurringItemId: string }
  | { ok: false; error: string; verdict?: AffordVerdict };

/**
 * Thin "use server" wrappers: auth, payload validation, and a localized
 * message around the plain functions in src/lib/data/afford.ts, which is what
 * scripts/verify-domain.ts drives directly. Same split as the payday check-in.
 */
async function affordContext(): Promise<{
  context: AffordContext;
  t: ReturnType<typeof getDictionary>["afford"];
  locale: "en" | "es";
}> {
  const [context, settings] = await Promise.all([getAppContext(), getSettings()]);
  const locale = isLocale(settings.language) ? settings.language : "en";
  return {
    context: {
      ...context,
      bufferPercent: settings.bufferPercent,
      bufferFloorAmount: num(settings.bufferFloorAmount),
      bufferFloorCurrency: settings.bufferFloorCurrency,
    },
    t: getDictionary(locale).afford,
    locale,
  };
}

/** Pure read: projects the affected periods and judges the purchase. Writes nothing. */
export async function evaluateAffordAction(payload: unknown): Promise<AffordEvaluateResult> {
  await requireAuth();
  const { context, t, locale } = await affordContext();
  const parsed = affordInputSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error, locale) };

  const evaluation = await evaluateAffordRequest(parsed.data, context);
  if (!evaluation.ok) return { ok: false, error: t.accountNoLongerActive };
  return { ok: true, verdict: evaluation.verdict, recorded: evaluation.recorded };
}

/** "I bought this": the feature's only write. Re-evaluates server-side and honours the acknowledgement gate before creating the item. */
export async function confirmAffordAction(payload: unknown): Promise<AffordConfirmResult> {
  await requireAuth();
  const { context, t, locale } = await affordContext();
  const parsed = affordInputSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: firstError(parsed.error, locale) };

  const result = await confirmAffordPurchase(parsed.data, context);
  if (!result.ok) {
    if (result.reason === "account_not_active") return { ok: false, error: t.accountNoLongerActive };
    return { ok: false, error: t.acknowledgeFirst, verdict: result.verdict };
  }

  revalidateApp();
  return { ok: true, message: t.boughtToast, recurringItemId: result.recurringItemId };
}
