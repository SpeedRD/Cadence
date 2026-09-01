import { stripHtml } from "@/lib/email/html";

import type { EmailCandidate } from "@/lib/email/types";

/** Raw fetch, not `@azure/msal-node` - see the note in `oauth/microsoft.ts`. */
const API_BASE = "https://graph.microsoft.com/v1.0/me/messages";

/** Bounds one sync's Graph list call before the shared keyword/sender filter runs. */
export const OUTLOOK_FETCH_CAP = 40;

interface GraphMessage {
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  body?: { contentType?: "text" | "html"; content?: string };
}

export async function listRecentOutlookCandidates(
  accessToken: string,
  since: Date,
): Promise<EmailCandidate[]> {
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    $orderby: "receivedDateTime desc",
    $top: String(OUTLOOK_FETCH_CAP),
    $select: "internetMessageId,subject,from,receivedDateTime,body",
  });

  const response = await fetch(`${API_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Graph message list failed: ${response.status}`);
  }
  const data = (await response.json()) as { value?: GraphMessage[] };

  const candidates: EmailCandidate[] = [];
  for (const message of data.value ?? []) {
    if (!message.internetMessageId) continue;
    const from = message.from?.emailAddress?.address ?? "";
    const bodyContent = message.body?.content ?? "";
    const bodyText =
      message.body?.contentType === "html" ? stripHtml(bodyContent) : bodyContent;
    const receivedAt = message.receivedDateTime
      ? new Date(message.receivedDateTime)
      : new Date();

    candidates.push({
      externalId: message.internetMessageId,
      subject: message.subject ?? "",
      from,
      receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      bodyText: bodyText.slice(0, 12_000),
    });
  }
  return candidates;
}
