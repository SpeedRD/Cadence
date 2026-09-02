/**
 * Deterministic merchant/description categorization for imported transactions.
 *
 * Rules are matched by Category.name, mirroring the lookup pattern already used
 * for LLM-suggested categories in src/lib/ingestion.ts (there is no stable
 * category slug in the schema — `name` is the de-facto stable key, seeded and
 * unique). Callers resolve the returned name to an id against the categories
 * that actually exist, so a rule referencing a category that isn't seeded in a
 * given environment simply yields no match.
 *
 * Rules are intentionally narrow and merchant-specific rather than broad
 * keyword guesses: a false positive (wrong category) is worse than leaving a
 * transaction Uncategorized, so we only match strings we're confident about.
 */

interface CategoryRule {
  category: string;
  /** Normalized (lowercase, alphanumeric-only) substrings that identify this category. */
  keywords: string[];
}

/**
 * Order matters: rules are checked top to bottom and the first match wins.
 * More specific merchants must come before generic ones they'd otherwise also
 * match — e.g. "ubereats" before "uber", so an Uber Eats charge lands in
 * Dining rather than Transport.
 */
const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "Dining",
    keywords: [
      "ubereats",
      "doordash",
      "grubhub",
      "mcdonalds",
      "burgerking",
      "pizzahut",
      "kfc",
      "starbucks",
      "chipotle",
      "wendys",
      "dominos",
      "tacobell",
      "subway",
      "cafeamerica",
      "restaurant",
    ],
  },
  {
    category: "Transport",
    keywords: [
      "uber",
      "lyft",
      "shell",
      "unitedpetroleum",
      "chevron",
      "exxon",
      "mobil",
      "gasstation",
      "parking",
    ],
  },
  {
    category: "Groceries",
    keywords: [
      "kroger",
      "safeway",
      "wholefoods",
      "traderjoes",
      "publix",
      "aldi",
      "costco",
      "supermarket",
      "grocery",
      "groceries",
    ],
  },
  {
    category: "Shopping",
    keywords: ["amazon", "amzn", "walmart", "target", "ebay", "bestbuy", "ikea"],
  },
  {
    category: "Subscriptions",
    keywords: [
      "anthropic",
      "openai",
      "netflix",
      "spotify",
      "hulu",
      "disneyplus",
      "github",
      "adobe",
      "dropbox",
      "icloud",
    ],
  },
];

function normalizeDescription(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Suggests a Category.name for a transaction description, or null when no
 * rule matches confidently. Only expense-type transactions are considered —
 * none of the current rules apply to income.
 */
export function suggestCategoryName(
  description: string | null | undefined,
  type: "EXPENSE" | "INCOME",
): string | null {
  if (type !== "EXPENSE" || !description) return null;

  const normalized = normalizeDescription(description);
  if (!normalized) return null;

  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((keyword) => normalized.includes(keyword))) {
      return rule.category;
    }
  }

  return null;
}

/**
 * Resolves the category a newly-imported row should get: an explicit,
 * still-valid category chosen during import always wins; otherwise falls
 * back to the automatic suggestion, if any of the caller's known categories
 * match it by name. Used by the CSV import action; kept dependency-free
 * (no Prisma) so it can be unit tested directly.
 */
export function resolveImportCategoryId(params: {
  explicitCategoryId: string | null;
  note: string | null;
  type: "EXPENSE" | "INCOME";
  knownCategoryIds: ReadonlySet<string>;
  categoryIdByName: ReadonlyMap<string, string>;
}): string | null {
  const { explicitCategoryId, note, type, knownCategoryIds, categoryIdByName } = params;

  if (explicitCategoryId && knownCategoryIds.has(explicitCategoryId)) {
    return explicitCategoryId;
  }

  const suggested = suggestCategoryName(note, type);
  if (!suggested) return null;

  return categoryIdByName.get(suggested.toLowerCase()) ?? null;
}
