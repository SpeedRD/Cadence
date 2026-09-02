"use server";

import { SETTINGS_ID, getSettings, requireAuth } from "@/lib/auth";
import { recomputeAllGoals } from "@/lib/goals";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { firstError, formObject, planningPreferencesSchema, settingsSchema } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

export async function updateDisplayCurrencyAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const parsed = settingsSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: { displayCurrency: parsed.data.displayCurrency },
    create: { id: SETTINGS_ID, displayCurrency: parsed.data.displayCurrency },
  });
  revalidateApp();
  return done(t.showingIn(parsed.data.displayCurrency));
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
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const count = await recomputeAllGoals();
  revalidateApp();
  return done(t.goalsRecalculated(count));
}

export async function savePlanningPreferencesAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const parsed = planningPreferencesSchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  await prisma.settings.upsert({
    where: { id: SETTINGS_ID },
    update: parsed.data,
    create: { id: SETTINGS_ID, ...parsed.data },
  });
  revalidateApp();
  return done(t.planningPreferencesSaved);
}

export async function toggleEssentialCategoryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  const t = getDictionary(locale).settingsPage;
  const categoryId = String(formData.get("categoryId") ?? "").trim();
  const isEssentialFixed = formData.get("isEssentialFixed") === "true";
  if (!categoryId) return fail(t.categoryNoLongerExists);

  await prisma.category.update({ where: { id: categoryId }, data: { isEssentialFixed } });
  revalidateApp();
  return done(isEssentialFixed ? t.categoryMarkedEssential : t.categoryUnmarkedEssential);
}
