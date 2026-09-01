import { z } from "zod";

import { CURRENCIES } from "@/lib/currency";
import { fromISODate } from "@/lib/date";
import type { Locale } from "@/lib/i18n";
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

const positiveAmount = z
  .string()
  .trim()
  .min(1, "Enter an amount")
  .transform((value, ctx) => {
    const parsed = Number(value.replace(/,/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      ctx.addIssue({ code: "custom", message: "Enter an amount greater than 0" });
      return z.NEVER;
    }
    return Math.round(parsed * 100) / 100;
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

export const accountSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, "Name the account").max(60),
  currency,
  type: z.enum(ACCOUNT_TYPES),
});

export const transactionSchema = z.object({
  id: z.string().trim().optional(),
  date: isoDate,
  amount: positiveAmount,
  currency,
  type: z.enum(["EXPENSE", "INCOME"]),
  accountId: z.string().trim().min(1, "Pick an account"),
  categoryId: optionalId,
  note: optionalText,
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
  amount: z
    .string()
    .trim()
    .transform((value, ctx) => {
      if (value === "") return null;
      const parsed = Number(value.replace(/,/g, ""));
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.addIssue({ code: "custom", message: "Enter 0 or more" });
        return z.NEVER;
      }
      return Math.round(parsed * 100) / 100;
    }),
  currency,
});

export const recurringSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, "Name the item").max(80),
  amount: positiveAmount,
  currency,
  frequency: z.enum(RECURRING_FREQUENCIES),
  kind: z.enum(RECURRING_KINDS),
  nextDate: isoDate,
  categoryId: optionalId,
  note: optionalText,
  active: z
    .string()
    .trim()
    .optional()
    .transform((value) => value === "on" || value === "true"),
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

export const paydayConfirmSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  period: z.enum(["A", "B"]),
  accounts: z
    .array(
      z.object({
        accountId: z.string().trim().min(1),
        reportedBalance: z.number(),
        incomeEntered: z.number().min(0),
        incomeNote: z.string().max(200).nullable(),
      }),
    )
    .min(1, "Add at least one active account"),
  goals: z.array(
    z.object({
      goalId: z.string().trim().min(1),
      plannedAmount: z.number().min(0),
    }),
  ),
  essentialCategories: z.array(
    z.object({
      categoryId: z.string().trim().min(1),
      plannedAmount: z.number().min(0),
    }),
  ),
  flexibleCategories: z.array(
    z.object({
      categoryId: z.string().trim().min(1),
      plannedAmount: z.number().min(0),
    }),
  ),
  buffer: z.number().min(0),
  includedCarryover: z.number(),
  acknowledgedDeficit: z.boolean(),
  acknowledgedZeroBuffer: z.boolean(),
});

export const planningPreferencesSchema = z.object({
  bufferPercent: z.coerce.number().int().min(0).max(100),
  bufferFloorAmount: z
    .string()
    .trim()
    .transform((value, ctx) => {
      const parsed = Number(value.replace(/,/g, ""));
      if (!Number.isFinite(parsed) || parsed < 0) {
        ctx.addIssue({ code: "custom", message: "Enter 0 or more" });
        return z.NEVER;
      }
      return Math.round(parsed * 100) / 100;
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
  "Check the form and try again": "Revisa el formulario e intenta de nuevo",
};

export function firstError(error: z.ZodError, locale: Locale = "en"): string {
  const message = error.issues[0]?.message ?? "Check the form and try again";
  if (locale === "es") return VALIDATION_MESSAGES_ES[message] ?? message;
  return message;
}
