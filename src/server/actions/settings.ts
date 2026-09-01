"use server";

import { SETTINGS_ID, requireAuth } from "@/lib/auth";
import { recomputeAllGoals } from "@/lib/goals";
import { isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { firstError, formObject, settingsSchema } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function updateDisplayCurrencyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const parsed = settingsSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error));

  await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: { displayCurrency: parsed.data.displayCurrency },
    create: { id: SETTINGS_ID, displayCurrency: parsed.data.displayCurrency },
  });
  revalidateApp();
  return done(`Showing amounts in ${parsed.data.displayCurrency}`);
}

export async function updateLanguageAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const language = String(formData.get("language") ?? "");
  if (!isLocale(language)) return fail("Unknown language");

  await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: { language },
    create: { id: SETTINGS_ID, language },
  });
  revalidateApp();
  return done(language === "es" ? "Mostrando Cadence en español" : "Showing Cadence in English");
}

/** Rebuild every Goal.savedAmount from its contributions. */
export async function recalculateGoalsAction(
  _previous: ActionState,
): Promise<ActionState> {
  await requireAuth();
  const count = await recomputeAllGoals();
  revalidateApp();
  return done(`Recalculated ${count} goal${count === 1 ? "" : "s"}`);
}
