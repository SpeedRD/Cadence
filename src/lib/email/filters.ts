/**
 * Shared candidate filter for both providers. Kept deliberately simple and
 * client-side (applied after a broad date-bounded fetch) so Gmail's search
 * syntax and Graph's $filter/$search quirks don't need to agree with each
 * other - one predicate, two fetchers.
 */
const SUBJECT_KEYWORDS = [
  "receipt",
  "invoice",
  "payment confirmation",
  "subscription",
  "order confirmed",
  "your order",
  "payment received",
];

const SENDER_DOMAINS = [
  "paypal.com",
  "amazon.com",
  "netflix.com",
  "spotify.com",
  "apple.com",
];

function senderDomain(from: string): string | null {
  const match = /@([a-z0-9.-]+\.[a-z]{2,})/i.exec(from);
  return match ? match[1].toLowerCase() : null;
}

export function isTransactionalEmail(subject: string, from: string): boolean {
  const subjectLower = subject.toLowerCase();
  if (SUBJECT_KEYWORDS.some((keyword) => subjectLower.includes(keyword))) {
    return true;
  }

  const domain = senderDomain(from);
  if (!domain) return false;
  return SENDER_DOMAINS.some(
    (known) => domain === known || domain.endsWith(`.${known}`),
  );
}
