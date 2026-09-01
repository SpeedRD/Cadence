import { toCurrency } from "@/lib/currency";
import { listRecentGmailCandidates } from "@/lib/email/gmail";
import { listRecentOutlookCandidates } from "@/lib/email/outlook";
import { getValidAccessToken } from "@/lib/email/tokens";
import { isTransactionalEmail } from "@/lib/email/filters";
import type { EmailCandidate } from "@/lib/email/types";
import { parseTransactionEmail } from "@/lib/llm/parse-transaction-email";
import { prisma } from "@/lib/prisma";
import { SETTINGS_ID } from "@/lib/auth";

import type { EmailConnection } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";

/** First sync on a freshly connected mailbox looks back this far. */
export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Caps LLM calls (and wall time) per account per sync run - each candidate is
 * one Claude request, so this keeps a single "Sync now" click, and a single
 * Vercel Cron invocation, inside typical serverless function time limits. A
 * mailbox with a bigger backlog catches up over a few syncs.
 */
export const MAX_CANDIDATES_PER_ACCOUNT = 20;

/** How many emails are parsed by the LLM at once. */
const PARSE_CONCURRENCY = 4;

export interface IngestionResult {
  accountsSynced: number;
  scanned: number;
  staged: number;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchCandidates(
  connection: EmailConnection,
  accessToken: string,
  since: Date,
): Promise<EmailCandidate[]> {
  return connection.provider === "GMAIL"
    ? listRecentGmailCandidates(accessToken, since)
    : listRecentOutlookCandidates(accessToken, since);
}

async function syncConnection(
  connection: EmailConnection,
  defaultCurrency: string,
  categoryNames: string[],
): Promise<{ scanned: number; staged: number }> {
  const now = new Date();
  const since =
    connection.lastSyncedAt ??
    new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000);

  const accessToken = await getValidAccessToken(connection);
  const candidates = await fetchCandidates(connection, accessToken, since);
  const transactional = candidates
    .filter((candidate) => isTransactionalEmail(candidate.subject, candidate.from))
    .slice(0, MAX_CANDIDATES_PER_ACCOUNT);

  const parsedRows = await mapWithConcurrency(
    transactional,
    PARSE_CONCURRENCY,
    async (candidate) => {
      const parsed = await parseTransactionEmail({
        subject: candidate.subject,
        from: candidate.from,
        receivedAt: candidate.receivedAt,
        bodyText: candidate.bodyText,
        defaultCurrency,
        categoryNames,
      });
      return parsed ? { candidate, parsed } : null;
    },
  );

  const categoryIdByName = new Map(
    (
      await prisma.category.findMany({ select: { id: true, name: true } })
    ).map((category) => [category.name.toLowerCase(), category.id]),
  );

  const rows: Prisma.StagedTransactionCreateManyInput[] = parsedRows
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .map(({ candidate, parsed }) => ({
      date: parsed.date,
      amount: parsed.amount,
      currency: parsed.currency,
      rawDescription: parsed.rawDescription,
      suggestedCategoryId: parsed.suggestedCategoryName
        ? (categoryIdByName.get(parsed.suggestedCategoryName.toLowerCase()) ?? null)
        : null,
      source: connection.provider,
      externalId: candidate.externalId,
      status: "PENDING",
      parsedAt: now,
    }));

  // skipDuplicates covers re-fetching the same email across syncs (the date
  // window overlaps `since` by design) via the (source, externalId) index.
  const result = rows.length
    ? await prisma.stagedTransaction.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 };

  await prisma.emailConnection.update({
    where: { id: connection.id },
    data: { lastSyncedAt: now },
  });

  return { scanned: transactional.length, staged: result.count };
}

/**
 * Runs every connected mailbox's sync. Used by both the manual "Sync now"
 * action and the /api/cron/ingest route, so the two never drift apart.
 */
export async function runIngestion(): Promise<IngestionResult> {
  const [connections, settings, categories] = await Promise.all([
    prisma.emailConnection.findMany(),
    prisma.settings.findUnique({ where: { id: SETTINGS_ID } }),
    prisma.category.findMany({ select: { name: true } }),
  ]);

  const defaultCurrency = toCurrency(settings?.displayCurrency);
  const categoryNames = categories.map((category) => category.name);

  let scanned = 0;
  let staged = 0;
  for (const connection of connections) {
    try {
      const result = await syncConnection(connection, defaultCurrency, categoryNames);
      scanned += result.scanned;
      staged += result.staged;
    } catch (error) {
      // One broken connection (revoked token, provider outage) shouldn't
      // block the others from syncing.
      console.error(`Sync failed for ${connection.provider} ${connection.emailAddress}:`, error);
    }
  }

  return { accountsSynced: connections.length, scanned, staged };
}
