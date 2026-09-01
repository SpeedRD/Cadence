import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "cadence_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

interface SessionPayload {
  iat: number;
  exp: number;
}

function secret(): string {
  return process.env.SESSION_SECRET || "cadence-insecure-development-secret";
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function createSessionToken(now: number = Date.now()): string {
  const payload: SessionPayload = {
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Signature + expiry check. Safe to run in the proxy (no database access). */
export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;

  const expected = Buffer.from(sign(body));
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  if (!timingSafeEqual(expected, received)) return false;

  try {
    const payload = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionPayload;
    return payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}
