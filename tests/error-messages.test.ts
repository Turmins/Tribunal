import assert from "node:assert/strict";
import test from "node:test";
import { ERROR_MESSAGES, userMessage } from "../src/error-messages.js";

test("§16.5: no error message contains a decision value", () => {
  for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
    assert.doesNotMatch(message, /not\s+justified|justified/i, `code ${code} contains a decision value`);
  }
});

test("§16.5: an unknown code exposes no details and invents no decision", () => {
  const fallback = userMessage("something_from_provider");
  assert.equal(fallback, "No result was produced.");
  assert.doesNotMatch(fallback, /justified/i);
});
