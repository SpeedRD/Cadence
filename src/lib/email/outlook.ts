import { stripHtml } from "@/lib/email/html";

import type { EmailCandidate, EmailCandidateBatch } from "@/lib/email/types";

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
): Promise<EmailCandidateBatch> {
  const params = new URLSearchParams({
    $filter: `receivedDateTime ge ${since.toISOString()}`,
    // Oldest first, which Graph supports directly: a run has to start at the
    // bottom of the window so that whatever its cap leaves behind is newer than
    // the cursor the run stores, and therefore still inside the next window.
    $orderby: "receivedDateTime asc",
    $top: String(OUTLOOK_FETCH_CAP),
    $select: "internetMessageId,subject,from,receivedDateTime,body",
  });

  const response = await fetch(`${API_BASE}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Graph message list failed: ${response.status}`);
  }
  const data = (await response.json()) as {
    value?: GraphMessage[];
    "@odata.nextLink"?: string;
  };
  const messages = data.value ?? [];

  // A next link means the window holds more than this page. A page that came
  // back full is treated the same way even without one, because being a page
  // behind only costs a re-fetch that the (source, externalId) dedup absorbs,
  // while wrongly declaring the window exhausted would skip what the page cut.
  const truncated =
    Boolean(data["@odata.nextLink"]) || messages.length >= OUTLOOK_FETCH_CAP;

  const candidates: EmailCandidate[] = [];
  for (const message of messages) {
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
  return { candidates, truncated };
}
