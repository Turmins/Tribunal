/**
 * User-facing failure messages (ARCHITECTURE §16.5). None of these messages
 * contains a decision value; this lexical barrier prevents an error from being
 * read as a verdict. Raw provider text is never exposed here.
 */
export const ERROR_MESSAGES: Record<string, string> = {
  provider_failure: "The model did not respond. No result was produced.",
  provider_error: "The model did not respond. No result was produced.",
  timeout: "The model response timed out.",
  empty_response: "The model returned an empty response. The result was rejected.",
  truncated_response: "The model response reached the length limit. The result was rejected.",
  unparseable_output: "The model response could not be parsed as JSON. The result was rejected.",
  schema_violation: "The response does not match the required format. The result was rejected.",
  length_violation: "The reasoning length is outside the allowed range. The result was rejected.",
  role_confusion: "The response matches another role's contract. The result was rejected.",
  enum_violation: "The response contains an invalid decision value. The result was rejected.",
  prompt_leak: "The response failed a safety check.",
  role_violation: "The response does not follow its assigned role. The result was rejected.",
  prompt_drift: "The prompt changed after the case was created. The result was rejected.",
  stage_not_reached: "This stage did not start because the previous stage requirements were not met.",
  run_aborted: "The call was stopped before a result was produced.",
  deadline_exceeded: "The overall case deadline expired.",
  advocate_failure: "Not all four arguments were produced. The judge stage did not start.",
  advocate_gate_failed: "Not all four arguments were produced. The judge stage did not start.",
  judge_failure: "Some decisions were not produced.",
  global_budget_exhausted: "The service's daily budget is exhausted. New cases are temporarily unavailable.",
  stage_error: "An internal error prevented the stage from completing. The case was closed.",
  budget_exhausted: "The case budget is exhausted. The judge stage did not start.",
  internal_error: "Internal service error.",
  request_failed: "The request was rejected.",
  validation_failed: "Please check the indictment fields.",
  malformed_json: "The request body could not be parsed as JSON.",
  payload_too_large: "The request exceeds the allowed size.",
  idempotency_key_missing: "A valid safe-retry key is required.",
  idempotency_key_conflict: "This key has already been used for a different indictment.",
  invalid_case_id: "Invalid case identifier.",
  case_not_found: "Case not found.",
  case_not_terminal: "The case is still under review; retries are available only after completion.",
  nothing_to_retry: "There are no failed roles to retry.",
  advocates_locked_by_verdicts: "The arguments cannot be rebuilt because decisions already rely on them.",
  retry_budget_exhausted: "The retry limit for this role is exhausted.",
};

export function userMessage(code: string | null | undefined): string {
  return (code && ERROR_MESSAGES[code]) || "No result was produced.";
}
