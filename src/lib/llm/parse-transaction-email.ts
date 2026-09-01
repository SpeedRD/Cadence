import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { CURRENCIES, type CurrencyCode } from "@/lib/currency";
import { fromISODate } from "@/lib/date";

const MODEL = "claude-opus-5";

const ParsedEmailSchema = z.object({
  /** False for anything that isn't clearly one financial transaction. */
  isTransaction: z.boolean(),
  date: z.string().nullable(),
  amount: z.number().nullable(),
  currency: z.enum(CURRENCIES).nullable(),
  rawDescription: z.string().nullable(),
  /** Must exactly match one of the category names given in the prompt, or null. */
  suggestedCategoryName: z.string().nullable(),
});

export interface ParsedTransactionEmail {
  date: Date;
  amount: number;
  currency: CurrencyCode;
  rawDescription: string;
  suggestedCategoryName: string | null;
}

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

function systemPrompt(defaultCurrency: string, categoryNames: string[]): string {
  return [
    "You extract a single financial transaction from one email for a personal finance app.",
    "",
    "Rules:",
    "- Only set isTransaction to true if the email clearly represents one completed financial transaction (a receipt, invoice, payment confirmation, subscription charge, or order confirmation).",
    "- Be conservative: if the email is a shipping update, promotional offer, newsletter, account notice, or is ambiguous in any way, set isTransaction to false and leave every other field null.",
    "- If the email describes more than one distinct transaction, set isTransaction to false rather than guessing which one to report.",
    "- date: the civil date the transaction occurred (YYYY-MM-DD). Prefer a transaction/order/charge date mentioned in the email body over the email's own send date.",
    `- amount: a positive number - the transaction total, not a subtotal, tax line, or shipping fee.`,
    `- currency: infer from symbols or codes in the email (e.g. $, RD$, DOP, €, EUR, USD). If genuinely unclear, use ${defaultCurrency}.`,
    "- rawDescription: a short human-readable summary of the merchant and what it was for, e.g. \"Netflix subscription\" or \"Starbucks - Santo Domingo\". Keep it under 80 characters.",
    categoryNames.length > 0
      ? `- suggestedCategoryName: if the merchant or description clearly matches one of these existing categories, return that category's name exactly as written; otherwise null. Categories: ${categoryNames.join(", ")}.`
      : "- suggestedCategoryName: always null (no categories exist yet).",
  ].join("\n");
}

/**
 * Returns null both on a confident "not a transaction" verdict and on any
 * parsing/API failure - the caller treats both the same way: skip this email.
 */
export async function parseTransactionEmail(input: {
  subject: string;
  from: string;
  receivedAt: Date;
  bodyText: string;
  defaultCurrency: string;
  categoryNames: string[];
}): Promise<ParsedTransactionEmail | null> {
  try {
    const response = await anthropic().messages.parse({
      model: MODEL,
      max_tokens: 1024,
      output_config: {
        format: zodOutputFormat(ParsedEmailSchema),
        effort: "low",
      },
      system: systemPrompt(input.defaultCurrency, input.categoryNames),
      messages: [
        {
          role: "user",
          content: [
            `From: ${input.from}`,
            `Subject: ${input.subject}`,
            `Received: ${input.receivedAt.toISOString()}`,
            "",
            input.bodyText || "(empty body)",
          ].join("\n"),
        },
      ],
    });

    const parsed = response.parsed_output;
    if (!parsed || !parsed.isTransaction) return null;
    if (!parsed.date || parsed.amount === null || parsed.amount <= 0) return null;
    if (!parsed.currency || !parsed.rawDescription) return null;

    const date = fromISODate(parsed.date);
    if (!date) return null;

    return {
      date,
      amount: Math.round(parsed.amount * 100) / 100,
      currency: parsed.currency,
      rawDescription: parsed.rawDescription.slice(0, 200),
      suggestedCategoryName: parsed.suggestedCategoryName,
    };
  } catch (error) {
    console.error("Email parse failed, skipping message:", error);
    return null;
  }
}
