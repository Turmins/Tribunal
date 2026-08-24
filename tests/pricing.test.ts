import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../src/config.js";
import { estimateTokens, resolveCost, tableCost, worstCaseJudgeStage } from "../src/pricing.js";

test("priority 5: provider-reported cost is authoritative", () => {
  const resolved = resolveCost("judge", 0.0421, 3000, 1200);
  assert.deepEqual(resolved, { costUsd: 0.0421, source: "provider" });
});

test("priority 5: missing provider cost falls back to the price table", () => {
  const resolved = resolveCost("advocate", 0, 1000, 1000);
  assert.equal(resolved.source, "table");
  assert.ok(resolved.costUsd > 0, "a zero live-call cost would defeat the budget");
  assert.equal(resolved.costUsd, tableCost("advocate", 1000, 1000));
});

test("priority 5: missing usage does not become a zero cost", () => {
  assert.ok(resolveCost("judge", undefined, 3000, 1200).costUsd > 0);
  assert.ok(resolveCost("judge", null, 3000, 1200).costUsd > 0);
});

test("priority 5: judges cost more than advocates at equal volume", () => {
  assert.ok(tableCost("judge", 1000, 1000) > tableCost("advocate", 1000, 1000));
});

test("priority 5: worst-case judge-stage cost includes all three judges", () => {
  const one = tableCost("judge", 3000, 1200);
  assert.ok(Math.abs(worstCaseJudgeStage(3000) - 3 * one) < 1e-9);
});

test("priority 5: economic settings from .env.example are consumed", () => {
  assert.equal(typeof config.GLOBAL_DAILY_BUDGET_USD, "number");
  assert.equal(typeof config.MAX_INFLIGHT_MODEL_CALLS, "number");
  assert.ok(config.GLOBAL_DAILY_BUDGET_USD > 0);
  assert.ok(config.MAX_INFLIGHT_MODEL_CALLS >= 1);
});

test("priority 5: token estimates are monotonic", () => {
  assert.ok(estimateTokens("x".repeat(4000)) > estimateTokens("x".repeat(400)));
});
