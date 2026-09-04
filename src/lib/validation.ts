import { z } from "zod";

import { CURRENCIES } from "@/lib/currency";
import { fromISODate } from "@/lib/date";
import type { Locale } from "@/lib/i18n";
import { AMOUNT_MAX, parseAmountInput, round2, type ParsedAmount } from "@/lib/money";
import {
  ACCOUNT_TYPES,
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
    active: z
      .string()
      .trim()
      .optional()
      .transform((value) => value === "on" || value === "true"),
  })
  .transform((value, ctx) => {
    if (value.accountId === null) {
      ctx.addIssue({ code: "custom", message: "Pick an account", path: ["accountId"] });
      return z.NEVER;
    }
    // The due date the user picked is also the item's anchor day: posting
    // advances nextDate but never rewrites anchorDay, so only an explicit edit
    // here can re-anchor an item. This is the one place app writes set it, so
    // no create or update path can leave it unset (see RecurringItem.anchorDay).
    const anchorDay = value.nextDate.getUTCDate();
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

export const contributionSchema = z.object({
  goalId: z.string().trim().min(1),
  amount: positiveAmount,
  date: isoDate,
  note: optionalText,
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
  "Check the form and try again": "Revisa el formulario e intenta de nuevo",
};

export function firstError(error: z.ZodError, locale: Locale = "en"): string {
  const message = error.issues[0]?.message ?? "Check the form and try again";
  if (locale === "es") return VALIDATION_MESSAGES_ES[message] ?? message;
  return message;
}
