/**
 * Display names for schema enums. Keyed by plain strings so client components
 * never pull the Prisma client into the browser bundle, and so a value the UI
 * has not seen before (a Phase 2 ingestion source, say) still renders.
 */
export const ACCOUNT_TYPES = ["CHECKING", "SAVINGS", "CASH", "OTHER"] as const;
export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  CHECKING: "Checking",
  SAVINGS: "Savings",
  CASH: "Cash",
  OTHER: "Other",
};

export const TRANSACTION_TYPES = ["EXPENSE", "INCOME", "TRANSFER", "EXTERNAL_TRANSFER"] as const;
export const TRANSACTION_TYPE_LABELS: Record<string, string> = {
  EXPENSE: "Expense",
  INCOME: "Income",
  TRANSFER: "Transfer",
  OPENING_BALANCE: "Opening balance",
  EXTERNAL_TRANSFER: "External transfer",
};

export const TRANSACTION_SOURCES = [
  "MANUAL",
  "CSV",
  "GMAIL",
  "OUTLOOK",
  "PAYPAL",
  "PAYDAY_CHECKIN",
  "RECURRING",
] as const;
export const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual",
  CSV: "CSV",
  GMAIL: "Gmail",
  OUTLOOK: "Outlook",
  PAYPAL: "PayPal",
  PAYDAY_CHECKIN: "Payday check-in",
  OPENING_BALANCE: "Opening balance",
  RECURRING: "Recurring",
};

export const CATEGORY_KINDS = ["EXPENSE", "INCOME"] as const;
export const CATEGORY_KIND_LABELS: Record<string, string> = {
  EXPENSE: "Expense",
  INCOME: "Income",
};

export const RECURRING_FREQUENCIES = [
  "WEEKLY",
  "BIWEEKLY",
  "SEMI_MONTHLY",
  "MONTHLY",
  "YEARLY",
] as const;
/**
 * RECURRING_FREQUENCIES minus SEMI_MONTHLY, for the Afford calculator's own
 * frequency picker. Afford's installment walk (installmentDates in
 * src/lib/afford.ts) has only ever taken one anchor day; giving a semi-
 * monthly installment plan its own due-day pair is a different feature this
 * app doesn't have, so the calculator simply never offers the option rather
 * than silently mis-computing an installment schedule for it.
 */
export const AFFORD_FREQUENCIES = RECURRING_FREQUENCIES.filter(
  (frequency) => frequency !== "SEMI_MONTHLY",
);
export const FREQUENCY_LABELS: Record<string, string> = {
  WEEKLY: "Weekly",
  BIWEEKLY: "Every 2 weeks",
  SEMI_MONTHLY: "Twice a month",
  MONTHLY: "Monthly",
  YEARLY: "Yearly",
};

export const RECURRING_KINDS = ["SUBSCRIPTION", "CONTRIBUTION"] as const;
export const RECURRING_KIND_LABELS: Record<string, string> = {
  SUBSCRIPTION: "Subscription",
  CONTRIBUTION: "Contribution",
};

export function labelFor(map: Record<string, string>, value: string): string {
  return map[value] ?? titleCase(value);
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(/[\s_]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
