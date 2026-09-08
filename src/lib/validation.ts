import { z } from "zod";

import { MAX_INSTALLMENTS, equalInstallmentAmount } from "@/lib/afford";
import { CURRENCIES } from "@/lib/currency";
import { fromISODate } from "@/lib/date";
import type { Locale } from "@/lib/i18n";
import { AMOUNT_MAX, parseAmountInput, round2, type ParsedAmount } from "@/lib/money";
import {
  ACCOUNT_TYPES,
  CATEGORY_KINDS,
  RECURRING_FREQUENCIES,
  RECURRING_KINDS,
} from "@/lib/labels";

const currency = z.enum(CURRENCIES);

const isoDate = z
  .string()
  .trim()
  .min(1, "Pick a date")
  .transform((value, ctx) => {
    const parsed = fromISODate(value);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date" });
      return z.NEVER;
    }
    return parsed;
  });

const optionalIsoDate = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (!value) return null;
    const parsed = fromISODate(value);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "Enter a valid date" });
      return z.NEVER;
    }
    return parsed;
  });

function amountIssue(reason: Exclude<ParsedAmount, { ok: true }>["reason"]): string {
  if (reason === "too_many_decimals") return "Use at most 2 decimal places";
  if (reason === "too_large") return "That amount is too large";
  if (reason === "empty") return "Enter an amount";
  return "Enter a valid amount";
}

/**
 * Amounts arrive as typed text (see parseAmountInput for what is accepted) and
 * are validated only after that normalization, so "12,50" from an iPhone's
 * Spanish decimal keypad is 12.50 rather than 1250 or an error.
 */
const positiveAmount = z
  .string()
  .trim()
  .min(1, "Enter an amount")
  .transform((value, ctx) => {
    const parsed = parseAmountInput(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: amountIssue(parsed.reason) });
      return z.NEVER;
    }
    if (parsed.amount <= 0) {
      ctx.addIssue({ code: "custom", message: "Enter an amount greater than 0" });
      return z.NEVER;
    }
    return parsed.amount;
  });

/** An optional amount: empty is null, anything typed must be greater than 0. */
const positiveAmountOrEmpty = z
  .string()
  .trim()
  .optional()
  .transform((value, ctx) => {
    if (!value) return null;
    const parsed = parseAmountInput(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: amountIssue(parsed.reason) });
      return z.NEVER;
    }
    if (parsed.amount <= 0) {
      ctx.addIssue({ code: "custom", message: "Enter an amount greater than 0" });
      return z.NEVER;
    }
    return parsed.amount;
  });

/** Zero allowed; an empty field is null so callers can treat it as "clear". */
const nonNegativeAmountOrEmpty = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (value === "") return null;
    const parsed = parseAmountInput(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: amountIssue(parsed.reason) });
      return z.NEVER;
    }
    if (parsed.amount < 0) {
      ctx.addIssue({ code: "custom", message: "Enter 0 or more" });
      return z.NEVER;
    }
    return parsed.amount;
  });

const optionalText = z
  .string()
  .trim()
  .max(500, "Keep notes under 500 characters")
  .transform((value) => (value === "" ? null : value));

const optionalId = z
  .string()
  .trim()
  .transform((value) => (value === "" || value === "none" ? null : value));

export const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{4,6}$/, "Use 4 to 6 digits");

const HEX_COLOR_MESSAGE = "Pick a color";

/**
 * The category form. Kind is validated here and gated on usage in the data
 * layer (updateCategory refuses a kind change while transactions are filed
 * under the category). Colors are the six-digit hex the color input emits.
 */
export const categorySchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, "Name the category").max(40, "Keep the name under 40 characters"),
  kind: z.enum(CATEGORY_KINDS),
  color: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^#[0-9a-f]{6}$/, HEX_COLOR_MESSAGE),
});

/** The reassignment step: the category being removed and where its rows go. */
export const reassignCategorySchema = z.object({
  id: z.string().trim().min(1),
  moveToId: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      // Absent (nothing picked), "" and "none" all mean the same to the user.
      if (!value || value === "none") {
        ctx.addIssue({ code: "custom", message: "Pick a category to move them to" });
        return z.NEVER;
      }
      return value;
    }),
});

export const changePinSchema = z
  .object({
    currentPin: pinSchema,
    pin: pinSchema,
    confirm: z.string().trim(),
  })
  .refine((value) => value.pin === value.confirm, {
    message: "Both entries must match",
    path: ["confirm"],
  });

export const recoverPinSchema = z
  .object({
    secret: z.string().min(1, "Enter the recovery secret"),
    pin: pinSchema,
    confirm: z.string().trim(),
  })
  .refine((value) => value.pin === value.confirm, {
    message: "Both entries must match",
    path: ["confirm"],
  });

export const openingBalanceSchema = z.object({
  accountId: z.string().trim().min(1, "Pick an account"),
  amount: positiveAmount,
  date: isoDate,
});

export const accountSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, "Name the account").max(60),
  currency,
  type: z.enum(ACCOUNT_TYPES),
});

export const transactionSchema = z
  .object({
    id: z.string().trim().optional(),
    date: isoDate,
    amount: positiveAmount,
    currency,
    type: z.enum(["EXPENSE", "INCOME", "EXTERNAL_TRANSFER"]),
    accountId: z.string().trim().min(1, "Pick an account"),
    categoryId: optionalId,
    note: optionalText,
    /** OUT/IN direction for an EXTERNAL_TRANSFER row - no paired leg, so this
     *  is the only place the direction is recorded. Absent/empty for every
     *  other type; normalized to null below regardless of what was
     *  submitted, so a stale value left over from switching the type field
     *  back to EXPENSE/INCOME in the form never survives into the database. */
    transferDirection: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === "OUT" || value === "IN" ? value : null)),
  })
  .transform((value, ctx) => {
    if (value.type === "EXTERNAL_TRANSFER") {
      if (value.transferDirection === null) {
        ctx.addIssue({
          code: "custom",
          message: "Pick a direction",
          path: ["transferDirection"],
        });
        return z.NEVER;
      }
      return { ...value, categoryId: null };
    }
    return { ...value, transferDirection: null };
  });

export const transferSchema = z
  .object({
    transferId: z.string().trim().optional(),
    date: isoDate,
    amount: positiveAmount,
    currency,
    fromAccountId: z.string().trim().min(1, "Pick a source account"),
    toAccountId: z.string().trim().min(1, "Pick a destination account"),
    note: optionalText,
    /**
     * Cross-currency only: what the receiving account was actually credited,
     * in its own currency. Blank keeps both legs at the entered amount (see
     * transferLegs in src/lib/transactions.ts).
     */
    receivedAmount: positiveAmountOrEmpty,
  })
  .refine((value) => value.fromAccountId !== value.toAccountId, {
    message: "Pick two different accounts",
    path: ["toAccountId"],
  });

export const budgetSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  period: z.enum(["A", "B"]),
  categoryId: optionalId,
  amount: nonNegativeAmountOrEmpty,
  currency,
});

/**
 * Automatic posting (src/lib/recurring-posting.ts) needs an account for every
 * item and a goal for a contribution, so the form refuses to save without
 * them - an item that saved fine but never posted would be the worst outcome.
 * The goal field is not rendered for a subscription, so it may be absent from
 * the FormData entirely and is normalized to null regardless of what was
 * submitted (a stale pick from switching Kind back never survives).
 */
const REMAINING_OCCURRENCES_MESSAGE = `Leave payments left blank, or use between 1 and ${MAX_INSTALLMENTS}`;

export const recurringSchema = z
  .object({
    id: z.string().trim().optional(),
    /** RecurringItem.updatedAt as the edit form saw it, so saveRecurringAction can refuse a stale write. */
    updatedAt: z
      .string()
      .trim()
      .optional()
      .transform((value) => {
        if (!value) return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
      }),
    /**
     * The item's nextDate as the edit form was rendered with it, so the
     * transform below can tell an edit that re-picked the due date from one
     * that left it alone. Absent on a new item; unparseable is treated as
     * absent, which falls back to re-anchoring (the pre-existing behaviour).
     */
    originalNextDate: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value ? fromISODate(value) : null)),
    name: z.string().trim().min(1, "Name the item").max(80),
    amount: positiveAmount,
    currency,
    frequency: z.enum(RECURRING_FREQUENCIES),
    kind: z.enum(RECURRING_KINDS),
    nextDate: isoDate,
    categoryId: optionalId,
    accountId: optionalId,
    goalId: z
      .string()
      .trim()
      .optional()
      .transform((value) => (!value || value === "none" ? null : value)),
    note: optionalText,
    /**
     * RecurringItem.remainingOccurrences as typed into the form: blank is an
     * open-ended item (null, what every item is unless told otherwise); a
     * number is how many occurrences are still owed counting the one due at
     * nextDate - the same meaning confirmAffordPurchase gives it, and the same
     * cap, so an installment plan entered by hand before Afford existed can be
     * retrofitted with its real countdown without recreating it.
     */
    remainingOccurrences: z
      .string()
      .trim()
      .optional()
      .transform((value, ctx) => {
        if (!value) return null;
        const count = Number(value);
        if (!Number.isInteger(count) || count < 1 || count > MAX_INSTALLMENTS) {
          ctx.addIssue({ code: "custom", message: REMAINING_OCCURRENCES_MESSAGE });
          return z.NEVER;
        }
        return count;
      }),
    active: z
      .string()
      .trim()
      .optional()
      .transform((value) => value === "on" || value === "true"),
  })
  .transform(({ originalNextDate, ...value }, ctx) => {
    if (value.accountId === null) {
      ctx.addIssue({ code: "custom", message: "Pick an account", path: ["accountId"] });
      return z.NEVER;
    }
    // The due date the user picks is also the item's anchor day: posting
    // advances nextDate but never rewrites anchorDay, so only an explicit
    // pick here can re-anchor an item. A new item always gets one (as does
    // confirmAffordPurchase for an installment plan), and an edit gets one
    // only when the date actually changed. An edit that leaves the date alone
    // leaves the anchor alone too - the form prefills the *next* occurrence,
    // which for an item due on the 31st is the 28th all through February, and
    // re-anchoring on every save would quietly move the bill to the 28th for
    // good the first time its amount was edited in a short month. Undefined
    // is skipped by the update, so the stored value survives untouched.
    const dateUnchanged =
      Boolean(value.id) &&
      originalNextDate !== null &&
      originalNextDate.getTime() === value.nextDate.getTime();
    const anchorDay = dateUnchanged ? undefined : value.nextDate.getUTCDate();
    if (value.kind === "CONTRIBUTION") {
      if (value.goalId === null) {
        ctx.addIssue({ code: "custom", message: "Pick a goal", path: ["goalId"] });
        return z.NEVER;
      }
      return { ...value, anchorDay, accountId: value.accountId, goalId: value.goalId };
    }
    return { ...value, anchorDay, accountId: value.accountId, goalId: null };
  });

export const goalSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, "Name the goal").max(80),
  targetAmount: positiveAmount,
  currency,
  targetDate: optionalIsoDate,
});

/**
 * A contribution moves money out of an account (see logManualContribution), so
 * the account is required the same way the transaction form requires one; the
 * server action then checks it still exists and is active.
 */
export const contributionSchema = z.object({
  goalId: z.string().trim().min(1),
  accountId: z
    .string()
    .trim()
    .optional()
    .transform((value, ctx) => {
      // Absent (nothing rendered), "" (nothing picked) and "none" all mean the
      // same thing to the user, so they get the same message.
      if (!value || value === "none") {
        ctx.addIssue({ code: "custom", message: "Pick an account" });
        return z.NEVER;
      }
      return value;
    }),
  amount: positiveAmount,
  date: isoDate,
  note: optionalText,
});

/** One auto-posted contribution's corrected amount, in the goal's currency. */
export const recurringContributionEditSchema = z.object({
  id: z.string().trim().min(1),
  amount: positiveAmount,
});

export const settingsSchema = z.object({
  displayCurrency: currency,
});

/** Just the account link of an existing recurring item - Step 3's per-account reassignment, which edits the same RecurringItem.accountId the Recurring page's form does. */
export const recurringAccountSchema = z.object({
  id: z.string().trim().min(1),
  accountId: z.string().trim().min(1, "Pick an account"),
});

/**
 * A money figure inside the payday payload. Unlike the form schemas above these
 * arrive as JSON numbers, so they need the bounds the text parser applies:
 * anything past a Decimal(14,2) column fails inside the write transaction as a
 * raw overflow, and a third decimal place would be summed at full precision but
 * stored rounded, leaving the totals and the rows that make them up disagreeing.
 */
const planAmount = z
  .number()
  .finite()
  .min(0)
  .max(AMOUNT_MAX)
  .transform(round2);

/** The same, for a reported balance, which may legitimately be negative. */
const signedPlanAmount = z
  .number()
  .finite()
  .min(-AMOUNT_MAX)
  .max(AMOUNT_MAX)
  .transform(round2);

/**
 * Keeps one entry per id, the last one winning, which is what the Budget write
 * did anyway. A repeated id would otherwise be summed twice into the plan
 * totals and write two allocation rows for one category.
 */
function dedupeBy<T>(key: (entry: T) => string) {
  return (entries: T[]): T[] => {
    const byKey = new Map<string, T>();
    for (const entry of entries) byKey.set(key(entry), entry);
    return [...byKey.values()];
  };
}

const plannedCategories = z
  .array(
    z.object({
      categoryId: z.string().trim().min(1),
      plannedAmount: planAmount,
    }),
  )
  .transform(dedupeBy((entry) => entry.categoryId));

export const paydayConfirmSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  period: z.enum(["A", "B"]),
  accounts: z
    .array(
      z.object({
        accountId: z.string().trim().min(1),
        reportedBalance: signedPlanAmount,
        incomeEntered: planAmount,
        incomeNote: z.string().max(200).nullable(),
      }),
    )
    .min(1, "Add at least one active account")
    .transform(dedupeBy((entry) => entry.accountId)),
  goals: z
    .array(
      z.object({
        goalId: z.string().trim().min(1),
        plannedAmount: planAmount,
      }),
    )
    .transform(dedupeBy((entry) => entry.goalId)),
  essentialCategories: plannedCategories,
  flexibleCategories: plannedCategories,
  includedCarryover: signedPlanAmount,
  acknowledgedDeficit: z.boolean(),
  acknowledgedZeroBuffer: z.boolean(),
});

const INSTALLMENT_COUNT_MESSAGE = `Use between 1 and ${MAX_INSTALLMENTS} installments`;

/**
 * The Afford calculator's payload. Sent as JSON, like the payday plan. Only
 * the price and the number of installments travel: the server derives the
 * one equal installment amount itself (equalInstallmentAmount), so the amount
 * the checks run on and the amount the RecurringItem records are the same
 * number by construction. `acknowledged` only matters to the confirm action,
 * which refuses a non-viable plan without it.
 */
export const affordInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name the purchase").max(80),
    totalAmount: z
      .number()
      .finite()
      .gt(0, "Enter a price greater than 0")
      .max(AMOUNT_MAX, "That amount is too large")
      .transform(round2),
    installments: z
      .number()
      .int(INSTALLMENT_COUNT_MESSAGE)
      .min(1, INSTALLMENT_COUNT_MESSAGE)
      .max(MAX_INSTALLMENTS, INSTALLMENT_COUNT_MESSAGE),
    currency,
    frequency: z.enum(RECURRING_FREQUENCIES),
    firstDate: isoDate,
    accountId: z.string().trim().min(1, "Pick an account"),
    acknowledged: z.boolean().default(false),
  })
  // A recurring item cannot post a zero, so a price that rounds to nothing
  // per installment is refused here rather than recorded as a 0 subscription.
  .refine((value) => equalInstallmentAmount(value.totalAmount, value.installments) > 0, {
    message: "That price is too small to split into that many installments",
    path: ["installments"],
  });

export const planningPreferencesSchema = z.object({
  bufferPercent: z.coerce.number().int().min(0).max(100),
  bufferFloorAmount: nonNegativeAmountOrEmpty.transform((value, ctx) => {
    if (value === null) {
      ctx.addIssue({ code: "custom", message: "Enter 0 or more" });
      return z.NEVER;
    }
    return value;
  }),
  bufferFloorCurrency: currency,
  carryoverIncludedByDefault: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "on" || value === "true"),
});

const rawDescriptionText = z
  .string()
  .trim()
  .min(1, "Add a description")
  .max(200, "Keep the description under 200 characters");

export const stagedEditSchema = z.object({
  id: z.string().trim().min(1),
  date: isoDate,
  amount: positiveAmount,
  currency,
  rawDescription: rawDescriptionText,
  accountId: optionalId,
  categoryId: optionalId,
});

export const stagedApproveSchema = z.object({
  id: z.string().trim().min(1),
  date: isoDate,
  amount: positiveAmount,
  currency,
  rawDescription: rawDescriptionText,
  accountId: z.string().trim().min(1, "Pick an account before approving"),
  categoryId: optionalId,
});

/** Turn a FormData into the plain object the schemas expect. */
export function formObject(formData: FormData): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") entries[key] = value;
  }
  return entries;
}

const VALIDATION_MESSAGES_ES: Record<string, string> = {
  "Pick a date": "Elige una fecha",
  "Enter a valid date": "Ingresa una fecha válida",
  "Enter an amount": "Ingresa un monto",
  "Enter an amount greater than 0": "Ingresa un monto mayor que 0",
  "Enter a valid amount": "Ingresa un monto válido",
  "Use at most 2 decimal places": "Usa como máximo 2 decimales",
  "That amount is too large": "Ese monto es demasiado grande",
  "Keep notes under 500 characters": "Mantén las notas en menos de 500 caracteres",
  "Use 4 to 6 digits": "Usa de 4 a 6 dígitos",
  "Name the account": "Ponle nombre a la cuenta",
  "Pick an account": "Elige una cuenta",
  "Pick a source account": "Elige una cuenta de origen",
  "Pick a destination account": "Elige una cuenta de destino",
  "Pick two different accounts": "Elige dos cuentas diferentes",
  "Enter 0 or more": "Ingresa 0 o más",
  "Name the item": "Ponle nombre al elemento",
  "Name the goal": "Ponle nombre a la meta",
  "Add a description": "Agrega una descripción",
  "Keep the description under 200 characters":
    "Mantén la descripción en menos de 200 caracteres",
  "Pick an account before approving": "Elige una cuenta antes de aprobar",
  "Add at least one active account": "Agrega al menos una cuenta activa",
  "Pick a direction": "Elige una dirección",
  "Pick a goal": "Elige una meta",
  "Name the category": "Ponle nombre a la categoría",
  "Keep the name under 40 characters": "Mantén el nombre en menos de 40 caracteres",
  "Pick a color": "Elige un color",
  "Pick a category to move them to": "Elige la categoría a la que moverlos",
  "Enter the recovery secret": "Ingresa el secreto de recuperación",
  "Both entries must match": "Ambas entradas deben coincidir",
  "Check the form and try again": "Revisa el formulario e intenta de nuevo",
  "Name the purchase": "Ponle nombre a la compra",
  "Enter a price greater than 0": "Ingresa un precio mayor que 0",
  "Use between 1 and 120 installments": "Usa entre 1 y 120 cuotas",
  "Leave payments left blank, or use between 1 and 120":
    "Deja los pagos restantes en blanco, o usa entre 1 y 120",
  "That price is too small to split into that many installments":
    "Ese precio es demasiado pequeño para dividirlo en tantas cuotas",
};

export function firstError(error: z.ZodError, locale: Locale = "en"): string {
  const message = error.issues[0]?.message ?? "Check the form and try again";
  if (locale === "es") return VALIDATION_MESSAGES_ES[message] ?? message;
  return message;
}
