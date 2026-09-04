"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import { getDictionary, isLocale } from "@/lib/i18n";
import { num } from "@/lib/money";
import { prisma } from "@/lib/prisma";
import { firstError, paydayConfirmSchema } from "@/lib/validation";

import { getAppContext } from "@/lib/data/context";
import {
  confirmPaydayCheckin,
  type PaydayAcknowledgementState,
} from "@/lib/data/payday";

import { done, fail, revalidateApp, type ActionState } from "./utils";

/**
 * The confirm action's state, widened with what the server measured when it
 * refused. The wizard renders its acknowledgements from the client's own
 * arithmetic, which can disagree with the server's if the exchange rates were
 * refreshed in between; handing back the server's verdict lets the dialog draw
 * the missing checkbox instead of stranding the user until they reload.
 */
export type PaydayActionState =
  | (NonNullable<ActionState> & { acknowledgements?: PaydayAcknowledgementState })
  | null;

/**
 * Thin "use server" wrapper: auth, JSON-payload parsing/validation, and
 * mapping confirmPaydayCheckin's typed result to a localized ActionState.
 * All of the actual business logic - the live recompute, the acknowledgment
 * gates, and the atomic transaction that writes income transactions,
 * reconciliation snapshots, plan-allocation audit rows, and Budget rows -
 * lives in confirmPaydayCheckin (src/lib/data/payday.ts), a plain function
 * with no requireAuth()/cookies() dependency so it's directly callable from
 * a bare Node/tsx script (e.g. scripts/verify-domain.ts) as well as from
 * here.
 */
export async function confirmPaydayCheckinAction(
  _previous: PaydayActionState,
  formData: FormData,
): Promise<PaydayActionState> {
  await requireAuth();
  const context = await getAppContext();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).payday;

  let payload: unknown;
  try {
    payload = JSON.parse(String(formData.get("payload") ?? ""));
  } catch {
    return fail(t.couldNotReadPlan);
  }
  const parsed = paydayConfirmSchema.safeParse(payload);
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const result = await confirmPaydayCheckin(parsed.data, {
    ...context,
    bufferPercent: settings.bufferPercent,
    bufferFloorAmount: num(settings.bufferFloorAmount),
    bufferFloorCurrency: settings.bufferFloorCurrency,
  });
  if (!result.ok) {
    if (result.reason === "no_active_accounts") return fail(t.noActiveAccounts);
    const message =
      result.reason === "deficit_not_acknowledged"
        ? t.acknowledgeDeficitFirst
        : t.acknowledgeZeroBufferFirst;
    return { ...fail(message)!, acknowledgements: result.acknowledgements };
  }

  revalidateApp();
  return done(t.checkinConfirmed);
}

/** Records that the user dismissed today's auto-opened prompt, so it stays available as a dashboard card without forcing the modal open again the same day. */
export async function dismissPaydayPromptAction(_previous: ActionState): Promise<ActionState> {
  await requireAuth();
  const context = await getAppContext();
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { checkinPromptDismissedOn: context.today },
  });
  revalidateApp();
  return done();
}
