import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";

/**
 * AES-256-GCM at rest for OAuth tokens. The key is derived by hashing
 * OAUTH_ENCRYPTION_KEY (any length) down to 32 bytes, so a plain passphrase
 * works as well as a `openssl rand -hex 32` value.
 */
const IV_LENGTH = 12;

function key(): Buffer {
  const secret = process.env.OAUTH_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error("OAUTH_ENCRYPTION_KEY is not set");
  }
  return createHash("sha256").update(secret).digest();
}

/** iv + authTag + ciphertext, base64-joined with ".". */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((buf) => buf.toString("base64")).join(".");
}

export function decrypt(payload: string): string {
  const [ivB64, authTagB64, ciphertextB64] = payload.split(".");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Malformed encrypted payload");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
