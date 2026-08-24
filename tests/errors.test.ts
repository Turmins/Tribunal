import assert from "node:assert/strict";
import test from "node:test";
import { AppError, mapError } from "../src/errors.js";
import { isUuid } from "../src/schemas.js";

test("priority 2: domain error codes reach the client unchanged", () => {
  assert.deepEqual(mapError(new AppError("case_not_terminal", 409)), { statusCode: 409, code: "case_not_terminal" });
  assert.deepEqual(mapError(new AppError("case_not_found", 404)), { statusCode: 404, code: "case_not_found" });
  assert.deepEqual(mapError(new AppError("nothing_to_retry", 409)), { statusCode: 409, code: "nothing_to_retry" });
  assert.deepEqual(mapError(new AppError("advocates_locked_by_verdicts", 409)),
    { statusCode: 409, code: "advocates_locked_by_verdicts" });
  assert.deepEqual(mapError(new AppError("idempotency_key_conflict", 409)),
    { statusCode: 409, code: "idempotency_key_conflict" });
});

test("priority 2: an oversized body is not labeled an internal error", () => {
  assert.deepEqual(mapError({ code: "FST_ERR_CTP_BODY_TOO_LARGE", statusCode: 413 }),
    { statusCode: 413, code: "payload_too_large" });
});

test("priority 2: internal errors do not expose details", () => {
  assert.deepEqual(mapError(new Error("connection terminated unexpectedly")),
    { statusCode: 500, code: "internal_error" });
  assert.deepEqual(mapError({ code: "23505", statusCode: 500 }), { statusCode: 500, code: "internal_error" });
});

test("priority 2: case identifiers are validated before database access", () => {
  assert.equal(isUuid("not-a-uuid"), false);
  assert.equal(isUuid(""), false);
  assert.equal(isUuid("db0b53aa-a6ce-4bb0-8506-f048c83eca62"), true);
});
