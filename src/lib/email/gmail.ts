import { stripHtml } from "@/lib/email/html";

import type { EmailCandidate } from "@/lib/email/types";

/** Raw fetch, not `googleapis` - see the note in `oauth/google.ts`. */
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Bounds one sync's Gmail List call before the shared keyword/sender filter runs. */
export const GMAIL_FETCH_CAP = 40;

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

function formatGmailDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}/${m}/${d}`;
}

export async function listRecentGmailCandidates(
  accessToken: string,
  since: Date,
): Promise<EmailCandidate[]> {
  const query = `after:${formatGmailDate(since)}`;
  const listUrl = `${API_BASE}/messages?${new URLSearchParams({
    q: query,
    maxResults: String(GMAIL_FETCH_CAP),
  }).toString()}`;

  const listResponse = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listResponse.ok) {
    throw new Error(`Gmail message list failed: ${listResponse.status}`);
  }
  const listData = (await listResponse.json()) as {
    messages?: { id: string }[];
  };
  const ids = (listData.messages ?? []).map((m) => m.id);

  const candidates: EmailCandidate[] = [];
  for (const id of ids) {
    const response = await fetch(`${API_BASE}/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) continue;
    const message = (await response.json()) as GmailMessage;
    const headers = message.payload?.headers;
    const messageId = header(headers, "Message-ID");
    if (!messageId) continue;

    const dateHeader = header(headers, "Date");
    const parsedDate = dateHeader ? new Date(dateHeader) : new Date();

    candidates.push({
      externalId: messageId,
      subject: header(headers, "Subject"),
      from: header(headers, "From"),
      receivedAt: Number.isNaN(parsedDate.getTime()) ? new Date() : parsedDate,
      bodyText: extractBody(message.payload).slice(0, 12_000),
    });
  }
  return candidates;
}
