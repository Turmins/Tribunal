import { config } from "../config.js";

/**
 * Last-resort secret scrubbing for anything the guarded tools print or write.
 *
 * Nothing in these tools formats a key deliberately, and no code path renders an
 * Authorization header. This exists because a provider error message can quote
 * the request that produced it, and one leaked key in a pasted terminal log is
 * unrecoverable. Redaction is applied at the single output boundary rather than
 * trusted to every call site.
 */

/** Common provider key shapes, redacted even when they are not this project's key. */
const KEY_PATTERNS: readonly RegExp[] = [
  /\bsk-or-v1-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /\bauthorization"\s*:\s*"[^"]*"/gi,
];

export const REDACTED = "[redacted]";

export function redact(value: string, secrets: readonly string[] = [config.OPENROUTER_API_KEY]): string {
  let output = value;
  for (const secret of secrets) {
    // A short or empty value would match everywhere and destroy the message.
    if (typeof secret === "string" && secret.length >= 8) {
      output = output.split(secret).join(REDACTED);
    }
  }
  for (const pattern of KEY_PATTERNS) output = output.replace(pattern, REDACTED);
  return output;
}

/** Provider errors may embed request context; expose only a redacted message. */
export function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redact(raw).slice(0, 300);
}
