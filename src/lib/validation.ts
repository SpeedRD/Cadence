import { z } from "zod";

import { CURRENCIES } from "@/lib/currency";
import { fromISODate } from "@/lib/date";
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

export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Check the form and try again";
}
