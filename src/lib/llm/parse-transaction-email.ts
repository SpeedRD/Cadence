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
 * What reading one email came to. "not_transaction" is the model's verdict
 * (or an answer too incomplete to stage) and is final: the email is done with.
 * "failed" means no verdict was reached - the API refused, was unreachable or
 * returned nothing usable - so the email must be looked at again later, and
 * the caller must not treat it as dealt with.
 */
export type ParseOutcome =
  | { status: "parsed"; transaction: ParsedTransactionEmail }
  | { status: "not_transaction" }
  | { status: "failed"; reason: string };

export async function parseTransactionEmail(input: {
  subject: string;
  from: string;
  receivedAt: Date;
  bodyText: string;
  defaultCurrency: string;
  categoryNames: string[];
}): Promise<ParseOutcome> {
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
    if (!parsed) {
      return { status: "failed", reason: `no structured answer (stop reason: ${response.stop_reason ?? "unknown"})` };
    }
    if (!parsed.isTransaction) return { status: "not_transaction" };
    if (!parsed.date || parsed.amount === null || parsed.amount <= 0) return { status: "not_transaction" };
    if (!parsed.currency || !parsed.rawDescription) return { status: "not_transaction" };

    const date = fromISODate(parsed.date);
    if (!date) return { status: "not_transaction" };

    return {
      status: "parsed",
      transaction: {
        date,
        amount: Math.round(parsed.amount * 100) / 100,
        currency: parsed.currency,
        rawDescription: parsed.rawDescription.slice(0, 200),
        suggestedCategoryName: parsed.suggestedCategoryName,
      },
    };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
