import { toCurrency } from "@/lib/currency";
import { listRecentGmailCandidates } from "@/lib/email/gmail";
import { listRecentOutlookCandidates } from "@/lib/email/outlook";
import { getValidAccessToken } from "@/lib/email/tokens";
import { isTransactionalEmail } from "@/lib/email/filters";
import type { EmailCandidate, EmailCandidateBatch } from "@/lib/email/types";
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
 * mailbox with a bigger backlog catches up over a few syncs: a run takes the
 * oldest candidates in its window and moves `lastSyncedAt` only as far as it
 * actually got, so the remainder is still in front of the next run.
 */
export const MAX_CANDIDATES_PER_ACCOUNT = 20;

/** How many emails are parsed by the LLM at once. */
const PARSE_CONCURRENCY = 4;

/**
 * How far the stuck-cursor fallback in `nextWindowStart` steps. Gmail's `after:`
 * takes whole seconds and the fetcher asks for one second of overlap on top, so
 * a smaller step would leave the next run querying for exactly the same
 * messages and the cursor would crawl a millisecond per sync.
 */
const STUCK_CURSOR_STEP_MS = 2_000;

export interface IngestionResult {
  /** Connections whose sync ran to the end. Some of their messages may still have failed: see messagesFailed. */
  accountsSynced: number;
  /** Connections that threw (revoked token, provider outage). Their cursor did not move. */
  accountsFailed: number;
  scanned: number;
  staged: number;
  /**
   * Messages the parser could not reach a verdict on (API error, rate limit,
   * unreachable). Each holds its connection's cursor at or before it, so the
   * next sync reads it again.
   */
  messagesFailed: number;
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
): Promise<EmailCandidateBatch> {
  return connection.provider === "GMAIL"
    ? listRecentGmailCandidates(accessToken, since)
    : listRecentOutlookCandidates(accessToken, since);
}

/**
 * Picks the window's new lower bound. `lastSyncedAt` may only move to an instant
 * the run genuinely dealt with, meaning every message older than it was either
 * staged or turned down by the transactional filter. That is what makes a
 * backlog drain instead of disappear: whatever a capped run leaves behind is
 * newer than the instant returned here, so the next run still sees it.
 *
 * Returns null when the run learned nothing it can safely act on, in which case
 * the caller leaves `lastSyncedAt` alone and retries the same window.
 */
function windowBoundary(input: {
  now: Date;
  since: Date;
  /** Everything the provider returned, oldest first. */
  candidates: EmailCandidate[];
  /** The transactional subset this run actually parsed, oldest first. */
  processed: EmailCandidate[];
  /** True when MAX_CANDIDATES_PER_ACCOUNT left transactional messages unparsed. */
  cappedByAccountLimit: boolean;
  /** True when the provider could not return the whole window. */
  providerTruncated: boolean;
}): Date | null {
  const { now, since, candidates, processed, cappedByAccountLimit, providerTruncated } =
    input;

  if (!cappedByAccountLimit && !providerTruncated) {
    // The provider handed back the whole window and every transactional message
    // in it was parsed, so the run is caught up to the moment it started.
    return now;
  }

  // Something was deliberately left for the next run. When the per-account cap
  // bit, the newest instant fully dealt with is the newest message parsed,
  // because the transactional messages left over are all newer than it.
  // Otherwise the provider truncated its own list, and the newest message it
  // returned is the boundary: everything up to there was either parsed or
  // rejected by the filter, and rejection is a final answer, not a deferral.
  const boundary = cappedByAccountLimit
    ? processed.at(-1)?.receivedAt
    : candidates.at(-1)?.receivedAt;
  if (!boundary) {
    // A truncated fetch that yielded no usable candidate means the fetch itself
    // gave out part-way, not that the window is empty. Holding the bound where
    // it is re-runs the same window instead of stepping over messages nothing
    // has looked at yet.
    return null;
  }
  if (boundary.getTime() > since.getTime()) {
    // Both providers filter inclusively, so the boundary message itself comes
    // back next run and the (source, externalId) dedup absorbs it - which is
    // what keeps messages sharing that exact instant from being skipped.
    return boundary;
  }

  // The boundary is at or behind the window's start, which takes more messages
  // sharing a single instant than one run can fetch. Any bound that stays there
  // repeats this run for ever, so step far enough to change what the provider
  // returns: that gives up whatever else shares those two seconds, where
  // stalling would give up everything after them.
  return new Date(since.getTime() + STUCK_CURSOR_STEP_MS);
}

/**
 * The cursor for the next run: windowBoundary(), held back to the oldest
 * message the parser failed on. A failed message is not dealt with, so the
 * cursor may not pass it; it only ever moves to the earliest of the candidates,
 * and never behind where this window started. The failed message itself stays
 * inside the next window (both providers filter inclusively), and everything
 * staged since is skipped by its key when read again.
 */
function nextWindowStart(input: Parameters<typeof windowBoundary>[0] & {
  /** When the oldest message the parser failed on was received; null when none failed. */
  earliestFailedAt: Date | null;
}): Date | null {
  const boundary = windowBoundary(input);
  if (!boundary || !input.earliestFailedAt) return boundary;
  return new Date(
    Math.max(input.since.getTime(), Math.min(boundary.getTime(), input.earliestFailedAt.getTime())),
  );
}

async function syncConnection(
  connection: EmailConnection,
  defaultCurrency: string,
  categoryNames: string[],
): Promise<{ scanned: number; staged: number; messagesFailed: number }> {
  const now = new Date();
  const since =
    connection.lastSyncedAt ??
    new Date(now.getTime() - DEFAULT_LOOKBACK_DAYS * 86_400_000);

  const accessToken = await getValidAccessToken(connection);
  const batch = await fetchCandidates(connection, accessToken, since);
  // Both fetchers return the oldest slice of the window, oldest first; sorting
  // again keeps the drain order right whatever a provider does with ties.
  const candidates = [...batch.candidates].sort(
    (a, b) => a.receivedAt.getTime() - b.receivedAt.getTime(),
  );

  // A message staged by an earlier run is done with: it is neither parsed
  // again nor counted against the cap. This is what makes it safe (and cheap)
  // to read a window twice, which a held cursor does on purpose.
  const alreadyStaged = new Set(
    (
      await prisma.stagedTransaction.findMany({
        where: {
          source: connection.provider,
          externalId: { in: candidates.map((candidate) => candidate.externalId) },
        },
        select: { externalId: true },
      })
    ).map((row) => row.externalId),
  );
  const allTransactional = candidates.filter(
    (candidate) =>
      !alreadyStaged.has(candidate.externalId) &&
      isTransactionalEmail(candidate.subject, candidate.from),
  );
  // Oldest first, so the ones the cap leaves behind are newer than everything
  // parsed here and stay inside the next run's window rather than falling out
  // of it for ever.
  const transactional = allTransactional.slice(0, MAX_CANDIDATES_PER_ACCOUNT);
  const cappedByAccountLimit = allTransactional.length > transactional.length;

  const parsedRows = await mapWithConcurrency(
    transactional,
    PARSE_CONCURRENCY,
    async (candidate) => {
      const outcome = await parseTransactionEmail({
        subject: candidate.subject,
        from: candidate.from,
        receivedAt: candidate.receivedAt,
        bodyText: candidate.bodyText,
        defaultCurrency,
        categoryNames,
      });
      return { candidate, outcome };
    },
  );

  const failures = parsedRows.flatMap(({ candidate, outcome }) =>
    outcome.status === "failed" ? [{ candidate, reason: outcome.reason }] : [],
  );
  if (failures.length > 0) {
    console.error(
      `Sync for ${connection.provider} ${connection.emailAddress}: ${failures.length} of ${transactional.length} message(s) could not be parsed and will be read again next sync (first: ${failures[0].reason})`,
    );
  }

  const categoryIdByName = new Map(
    (
      await prisma.category.findMany({ select: { id: true, name: true } })
    ).map((category) => [category.name.toLowerCase(), category.id]),
  );

  const rows: Prisma.StagedTransactionCreateManyInput[] = parsedRows.flatMap(
    ({ candidate, outcome }) =>
      outcome.status === "parsed"
        ? [
            {
              date: outcome.transaction.date,
              amount: outcome.transaction.amount,
              currency: outcome.transaction.currency,
              rawDescription: outcome.transaction.rawDescription,
              suggestedCategoryId: outcome.transaction.suggestedCategoryName
                ? (categoryIdByName.get(outcome.transaction.suggestedCategoryName.toLowerCase()) ?? null)
                : null,
              source: connection.provider,
              externalId: candidate.externalId,
              status: "PENDING" as const,
              parsedAt: now,
            },
          ]
        : [],
  );

  // skipDuplicates covers re-fetching the same email across syncs (the date
  // window overlaps `since` by design) via the (source, externalId) index.
  const result = rows.length
    ? await prisma.stagedTransaction.createMany({ data: rows, skipDuplicates: true })
    : { count: 0 };

  const windowStart = nextWindowStart({
    now,
    since,
    candidates,
    processed: transactional,
    cappedByAccountLimit,
    providerTruncated: batch.truncated,
    earliestFailedAt: failures.reduce<Date | null>(
      (earliest, { candidate }) =>
        !earliest || candidate.receivedAt.getTime() < earliest.getTime() ? candidate.receivedAt : earliest,
      null,
    ),
  });
  if (windowStart) {
    await prisma.emailConnection.update({
      where: { id: connection.id },
      data: { lastSyncedAt: windowStart },
    });
  }

  return { scanned: transactional.length, staged: result.count, messagesFailed: failures.length };
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

  let accountsSynced = 0;
  let accountsFailed = 0;
  let scanned = 0;
  let staged = 0;
  let messagesFailed = 0;
  for (const connection of connections) {
    try {
      const result = await syncConnection(connection, defaultCurrency, categoryNames);
      accountsSynced += 1;
      scanned += result.scanned;
      staged += result.staged;
      messagesFailed += result.messagesFailed;
    } catch (error) {
      // One broken connection (revoked token, provider outage) shouldn't
      // block the others from syncing. It is counted, not hidden: the caller
      // reports it.
      accountsFailed += 1;
      console.error(`Sync failed for ${connection.provider} ${connection.emailAddress}:`, error);
    }
  }

  return { accountsSynced, accountsFailed, scanned, staged, messagesFailed };
}
