import assert from "node:assert/strict";
import test from "node:test";
import { judgeStageOutcome } from "../src/case-status.js";

test("P0-1: zero successful judges makes a case failed, not partial", () => {
  assert.deepEqual(judgeStageOutcome(0), { status: "failed", reason: "judge_failure" });
});

test("P0-1: one or two successful judges produce partial", () => {
  assert.equal(judgeStageOutcome(1).status, "partial");
  assert.equal(judgeStageOutcome(2).status, "partial");
});

test("P0-1: three successful judges produce completed with no failure reason", () => {
  assert.deepEqual(judgeStageOutcome(3), { status: "completed", reason: null });
});
