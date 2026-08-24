import assert from "node:assert/strict";
import test from "node:test";
import { CANARY, ContractError, isRetryable, validateModelOutput } from "../src/schemas.js";

const long = "x".repeat(400);
const layerOf = (fn: () => unknown): string => {
  try { fn(); return "did not throw"; }
  catch (error) { return error instanceof ContractError ? error.layer : `not a ContractError: ${String(error)}`; }
};
const codeOf = (fn: () => unknown): string => {
  try { fn(); return "did not throw"; }
  catch (error) { return error instanceof ContractError ? error.code : String(error); }
};

test("L2 remains a shape violation while invalid enum values are L3", () => {
  assert.equal(layerOf(() => validateModelOutput(JSON.stringify({ position: "justified", reasoning: long, confidence: 0.8 }), "advocate", "justified")), "L2");
  assert.equal(layerOf(() => validateModelOutput(JSON.stringify({ position: "maybe", reasoning: long }), "advocate", "justified")), "L3");
});

test("L4: reasoning length is diagnosed separately from schema violations", () => {
  assert.equal(layerOf(() => validateModelOutput(JSON.stringify({ position: "justified", reasoning: "Yes." }), "advocate", "justified")), "L4");
  assert.equal(codeOf(() => validateModelOutput(JSON.stringify({ position: "justified", reasoning: "Yes." }), "advocate", "justified")), "length_violation");
  assert.equal(layerOf(() => validateModelOutput(JSON.stringify({ decision: "justified", reasoning: "y".repeat(5000) }), "judge", null)), "L4");
});

test("L6: role-contract confusion has a distinct diagnosis", () => {
  assert.equal(codeOf(() => validateModelOutput(JSON.stringify({ decision: "justified", reasoning: long }), "advocate", "justified")), "role_confusion");
  assert.equal(codeOf(() => validateModelOutput(JSON.stringify({ position: "justified", reasoning: long }), "judge", null)), "role_confusion");
});

test("L5: an advocate cannot change its assigned stance", () => {
  assert.equal(codeOf(() => validateModelOutput(JSON.stringify({ position: "not_justified", reasoning: long }), "advocate", "justified")), "role_violation");
});

test("L7: a canary in a response is a non-retryable prompt leak", () => {
  const leaked = JSON.stringify({ decision: "justified", reasoning: `${long} ${CANARY}` });
  assert.equal(layerOf(() => validateModelOutput(leaked, "judge", null)), "L7");
  assert.equal(codeOf(() => validateModelOutput(leaked, "judge", null)), "prompt_leak");
  assert.equal(isRetryable(new ContractError("L7", "prompt_leak")), false);
  assert.equal(isRetryable(new ContractError("L4", "length_violation")), true);
});

test("the canary is present in every composed prompt", async () => {
  const { promptFor, roles } = await import("../src/prompts-registry.js");
  for (const role of roles) {
    const prompt = await promptFor(role.name);
    assert.ok(prompt.text.includes(CANARY), `${role.name}: prompt is missing the canary`);
  }
});

test("valid responses continue to pass", () => {
  assert.equal((validateModelOutput(JSON.stringify({ position: "justified", reasoning: long }), "advocate", "justified") as any).position, "justified");
  assert.equal((validateModelOutput(JSON.stringify({ decision: "not_justified", reasoning: long }), "judge", null) as any).decision, "not_justified");
});
