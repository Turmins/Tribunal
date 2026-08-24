/** Error with a domain code that must reach the client unchanged (ARCHITECTURE §11.1). */
export class AppError extends Error {
  constructor(public readonly code: string, public readonly statusCode: number) { super(code); }
}

export interface MappedError { statusCode: number; code: string }

const FRAMEWORK_CODES: Record<string, MappedError> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { statusCode: 413, code: "payload_too_large" },
  FST_ERR_CTP_INVALID_JSON_BODY: { statusCode: 400, code: "malformed_json" },
  FST_ERR_CTP_EMPTY_JSON_BODY: { statusCode: 400, code: "malformed_json" },
};

/**
 * Map an exception to an HTTP status and code. Internal failures collapse to
 * internal_error so database or provider details are not exposed; domain codes
 * are preserved as-is.
 */
export function mapError(error: unknown): MappedError {
  const candidate = error as { code?: unknown; statusCode?: unknown } | null;
  const rawCode = typeof candidate?.code === "string" ? candidate.code : undefined;
  const known = rawCode ? FRAMEWORK_CODES[rawCode] : undefined;
  if (known) return known;

  const statusCode = typeof candidate?.statusCode === "number" ? candidate.statusCode : 500;
  if (statusCode >= 500 || statusCode < 400) return { statusCode: 500, code: "internal_error" };
  const domainCode = rawCode && !rawCode.startsWith("FST_") && /^[a-z][a-z0-9_]*$/.test(rawCode)
    ? rawCode : "request_failed";
  return { statusCode, code: domainCode };
}
