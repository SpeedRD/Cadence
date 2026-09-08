import { createHash, timingSafeEqual } from "node:crypto";

/**
 * PIN recovery is opt-in: it exists only when the server environment carries
 * RECOVERY_SECRET (see .env.example). Separate from SESSION_SECRET (which
 * signs cookies and would let a holder mint sessions without ever touching
 * the PIN) and CRON_SECRET (which the cron routes carry in the clear on every
 * scheduled request). Kept apart from src/lib/auth.ts, which pulls in
 * next/headers, so this stays importable from plain scripts.
 */
export function isRecoveryConfigured(): boolean {
  return Boolean(process.env.RECOVERY_SECRET);
}

/**
 * Constant-time comparison against RECOVERY_SECRET. Both sides are hashed
 * first so the comparison never depends on the candidate's length, and an
 * unset secret refuses every candidate rather than matching an empty one.
 */
export function verifyRecoverySecret(candidate: string): boolean {
  const expected = process.env.RECOVERY_SECRET;
  if (!expected || !candidate) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(candidate), digest(expected));
}
