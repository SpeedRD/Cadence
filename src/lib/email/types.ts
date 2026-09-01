/** A message pulled from Gmail or Graph, before the transactional-content filter. */
export interface EmailCandidate {
  /** RFC 2822 Message-ID (Gmail) / internetMessageId (Graph) - the externalId. */
  externalId: string;
  subject: string;
  from: string;
  receivedAt: Date;
  bodyText: string;
}
