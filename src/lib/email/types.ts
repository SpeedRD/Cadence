/** A message pulled from Gmail or Graph, before the transactional-content filter. */
export interface EmailCandidate {
  /** RFC 2822 Message-ID (Gmail) / internetMessageId (Graph) - the externalId. */
  externalId: string;
  subject: string;
  from: string;
  receivedAt: Date;
  bodyText: string;
}

/**
 * One provider fetch: the slice of the sync window it returned, oldest message
 * first, plus whether that slice was the whole window.
 */
export interface EmailCandidateBatch {
  candidates: EmailCandidate[];
  /**
   * True when the provider could not hand back every message in the window, so
   * messages newer than the last candidate here are still waiting for a later
   * run and the caller must not move its cursor past them.
   */
  truncated: boolean;
}
