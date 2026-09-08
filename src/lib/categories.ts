/**
 * Category shapes shared by the settings UI and the data layer. Kept free of
 * any database import so the client components that render the category
 * list can use them without dragging the Prisma client into the browser
 * bundle (the same reason src/lib/labels.ts keys enums by plain strings).
 */

/**
 * What still points at a category - the three references a delete has to
 * resolve first. StagedTransaction.suggestedCategoryId and
 * PaydayPlanAllocation.categoryId are SetNull on delete and are only ever
 * suggestions or audit trail, so they are not counted.
 */
export interface CategoryUsage {
  transactions: number;
  recurringItems: number;
  budgets: number;
}

/**
 * The two categories whole calculations hang off. "subscription" is the
 * category whose spending safe-to-spend and the period budget treat as
 * already set aside by the payday plan (src/lib/data/period-summary.ts);
 * "savings" is where the monthly pace files saving rather than spending
 * (src/lib/data/monthly.ts) and where every manual goal contribution's
 * expense lands (src/lib/goals.ts). Deleting either would silently change
 * those figures, so neither can be deleted - only renamed or recolored.
 */
export type ProtectedCategoryReason = "subscription" | "savings";

export interface CategoryRow {
  id: string;
  name: string;
  kind: "EXPENSE" | "INCOME";
  color: string;
  isSubscriptionDefault: boolean;
  isSavingsDefault: boolean;
  isEssentialFixed: boolean;
  usage: CategoryUsage;
  /** Why this category can never be deleted, or null when it can. */
  protectedBy: ProtectedCategoryReason | null;
}

export function protectedCategoryReason(category: {
  isSubscriptionDefault: boolean;
  isSavingsDefault: boolean;
}): ProtectedCategoryReason | null {
  if (category.isSubscriptionDefault) return "subscription";
  if (category.isSavingsDefault) return "savings";
  return null;
}

export function isUnused(usage: CategoryUsage): boolean {
  return usage.transactions === 0 && usage.recurringItems === 0 && usage.budgets === 0;
}
