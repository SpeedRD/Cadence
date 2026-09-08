"use server";

import { getSettings, requireAuth } from "@/lib/auth";
import {
  createCategory,
  deleteCategoryIfUnused,
  reassignAndDeleteCategory,
  updateCategory,
} from "@/lib/data/categories";
import { getDictionary, isLocale } from "@/lib/i18n";
import { prisma } from "@/lib/prisma";
import { categorySchema, firstError, formObject, reassignCategorySchema } from "@/lib/validation";

import { done, fail, revalidateApp, type ActionState } from "./utils";

async function dictionary() {
  const settings = await getSettings();
  const locale = isLocale(settings.language) ? settings.language : "en";
  return { locale, t: getDictionary(locale).settingsPage };
}

export async function saveCategoryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const { locale, t } = await dictionary();
  const parsed = categorySchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const { id, ...values } = parsed.data;
  const result = id ? await updateCategory({ id, ...values }) : await createCategory(values);
  if (!result.ok) {
    if (result.reason === "not_found") return fail(t.categoryNoLongerExists);
    if (result.reason === "name_taken") return fail(t.categoryNameTaken);
    return fail(t.categoryKindInUse(result.transactions));
  }

  revalidateApp();
  return done(id ? t.categoryUpdated(values.name) : t.categoryCreated(values.name));
}

/**
 * Removes a category nothing is filed under. One still in use is left alone
 * and its counts come back on the state, so the client opens the
 * reassignment step (reassignCategoryAction) instead.
 */
export async function deleteCategoryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const { t } = await dictionary();
  const id = String(formData.get("id") ?? "").trim();
  if (!id) return fail(t.categoryNoLongerExists);

  const category = await prisma.category.findUnique({ where: { id }, select: { name: true } });
  if (!category) return fail(t.categoryNoLongerExists);

  const result = await deleteCategoryIfUnused(id);
  if (!result.ok) {
    if (result.reason === "not_found") return fail(t.categoryNoLongerExists);
    if (result.reason === "protected") {
      return fail(
        result.protectedBy === "subscription"
          ? t.protectedSubscriptionHint(category.name)
          : t.protectedSavingsHint(category.name),
      );
    }
    return fail(t.categoryInUse, { categoryUsage: result.usage });
  }

  revalidateApp();
  return done(t.categoryDeleted(category.name));
}

/**
 * The reassignment step: moves every transaction and recurring item filed
 * under the category to the chosen one, clears the category's budgets, and
 * removes it - one database transaction, see reassignAndDeleteCategory.
 */
export async function reassignCategoryAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await requireAuth();
  const { locale, t } = await dictionary();
  const parsed = reassignCategorySchema.safeParse(formObject(formData));
  if (!parsed.success) return fail(firstError(parsed.error, locale));

  const category = await prisma.category.findUnique({
    where: { id: parsed.data.id },
    select: { name: true },
  });
  if (!category) return fail(t.categoryNoLongerExists);

  const result = await reassignAndDeleteCategory(parsed.data.id, parsed.data.moveToId);
  if (!result.ok) {
    switch (result.reason) {
      case "not_found":
        return fail(t.categoryNoLongerExists);
      case "target_not_found":
        return fail(t.categoryTargetNoLongerExists);
      case "same_category":
        return fail(t.categorySameTarget);
      case "kind_mismatch":
        return fail(t.categoryKindMismatch);
      case "protected":
        return fail(
          result.protectedBy === "subscription"
            ? t.protectedSubscriptionHint(category.name)
            : t.protectedSavingsHint(category.name),
        );
    }
  }

  revalidateApp();
  return done(
    t.categoryReassigned(category.name, result.moved.transactions + result.moved.recurringItems),
  );
}
