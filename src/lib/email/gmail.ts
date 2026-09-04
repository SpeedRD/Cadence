import { stripHtml } from "@/lib/email/html";

import type { EmailCandidate, EmailCandidateBatch } from "@/lib/email/types";

/** Raw fetch, not `googleapis` - see the note in `oauth/google.ts`. */
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Bounds the message bodies one sync downloads before the shared filter runs. */
export const GMAIL_FETCH_CAP = 40;

/**
 * Gmail lists ids newest first (by internalDate) and offers no way to reverse
 * that, so the oldest messages in a window sit on the last page. Listing is ids
 * only and cheap, so the whole window is paged before a single body is
 * downloaded, and only the oldest GMAIL_FETCH_CAP of the ids are then fetched:
 * the expensive half of the call stays as bounded as it was while a run drains
 * the window from the bottom.
 *
 * 500 is the maximum page Gmail allows, and ten of them cover 5,000 messages
 * between two syncs - two orders of magnitude past what the daily cron leaves
 * behind, and still only ten small requests. A window even larger than that
 * cannot list its oldest ids at all, so the run drains from the oldest id it
 * could list; that needs a first sync of a mailbox taking 160+ messages a day.
 */
const LIST_PAGE_SIZE = 500;
const MAX_LIST_PAGES = 10;

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  /** Epoch milliseconds, as a string. */
  internalDate?: string;
  payload?: {
    headers?: GmailHeader[];
    mimeType?: string;
    body?: { data?: string };
    parts?: GmailMessagePart[];
  };
}

function header(headers: GmailHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
    "utf-8",
  );
}

/** Depth-first search for a text/plain part, falling back to text/html. */
function extractBody(payload: GmailMessage["payload"]): string {
  if (!payload) return "";

  let plain: string | null = null;
  let html: string | null = null;

  const visit = (part: GmailMessagePart) => {
    if (part.mimeType === "text/plain" && part.body?.data && plain === null) {
      plain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data && html === null) {
      html = decodeBase64Url(part.body.data);
    }
    for (const child of part.parts ?? []) visit(child);
  };
  visit(payload);

  if (plain !== null) return plain;
  if (html !== null) return stripHtml(html);
  return "";
}

/**
 * internalDate is the timestamp Gmail itself filters `after:` on and orders its
 * list by, so the sync cursor has to be built from it. The Date header is a
 * sender-supplied clock that can sit well either side of it, and a cursor taken
 * from it would step over messages this run never looked at.
 */
function messageReceivedAt(
  message: GmailMessage,
  headers: GmailHeader[] | undefined,
): Date {
  const internalDate = Number(message.internalDate);
  if (Number.isFinite(internalDate) && internalDate > 0) {
    return new Date(internalDate);
  }

  const dateHeader = header(headers, "Date");
  const parsed = dateHeader ? new Date(dateHeader) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function listRecentGmailCandidates(
  accessToken: string,
  since: Date,
): Promise<EmailCandidateBatch> {
  // Seconds since the epoch rather than YYYY/MM/DD: Gmail reads a bare date as
  // midnight PST, which would stretch every window back by up to a day and keep
  // re-serving messages the pipeline has already drained. The extra second
  // covers `after:` being exclusive, so a message sharing its second with the
  // cursor is still visible to the next run.
  const query = `after:${Math.floor(since.getTime() / 1000) - 1}`;

  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(LIST_PAGE_SIZE),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const listResponse = await fetch(`${API_BASE}/messages?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!listResponse.ok) {
      throw new Error(`Gmail message list failed: ${listResponse.status}`);
    }
    const listData = (await listResponse.json()) as {
      messages?: { id: string }[];
      nextPageToken?: string;
    };
    for (const message of listData.messages ?? []) ids.push(message.id);

    pageToken = listData.nextPageToken;
    if (!pageToken) break;
  }

  // The list runs newest first, so its tail is the oldest slice of the window;
  // reversing puts this run in draining order. Whatever sits ahead of the slice
  // is newer than everything fetched here, so it stays inside the next window.
  const oldestFirst = ids.slice(-GMAIL_FETCH_CAP).reverse();
  let truncated = Boolean(pageToken) || ids.length > oldestFirst.length;

  const candidates: EmailCandidate[] = [];
  for (const id of oldestFirst) {
    const response = await fetch(`${API_BASE}/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      // Stop at the first failure rather than skipping past it. The caller only
      // advances its cursor as far as the newest candidate returned here, so
      // this message and everything after it is retried on the next run instead
      // of being silently passed over.
      truncated = true;
      break;
    }
    const message = (await response.json()) as GmailMessage;
    const headers = message.payload?.headers;
    const messageId = header(headers, "Message-ID");
    if (!messageId) continue;

    candidates.push({
      externalId: messageId,
      subject: header(headers, "Subject"),
      from: header(headers, "From"),
      receivedAt: messageReceivedAt(message, headers),
      bodyText: extractBody(message.payload).slice(0, 12_000),
    });
  }
  return { candidates, truncated };
}
