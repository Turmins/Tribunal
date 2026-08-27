import assert from "node:assert/strict";
import test from "node:test";
import { caseLabel, historyLabel } from "../client/src/labels.js";

const view = (status: string, stage: string, advocates = 0, judges = 0) =>
  ({ status, stage, progress: { advocates_done: advocates, judges_done: judges } });

test("P0-2: a newly created case is not labeled complete", () => {
  const label = caseLabel(view("queued", "intake"));
  assert.doesNotMatch(label, /complete/i);
  assert.match(label, /accepted/i);
});

test("P0-2: a partial result does not look fully complete", () => {
  const label = caseLabel(view("partial", "finished", 4, 2));
  assert.notEqual(label, "Review complete");
  assert.match(label, /partial/i);
});

test("P0-2: the stage between advocates and judges does not look complete", () => {
  assert.doesNotMatch(caseLabel(view("running", "advocates_complete", 4, 0)), /complete/i);
});

test("P0-2: terminal status takes precedence over stage", () => {
  assert.match(caseLabel(view("failed", "finished")), /failed/i);
  assert.equal(caseLabel(view("completed", "finished", 4, 3)), "Review complete");
});

test("P0-2: stages show progress", () => {
  assert.match(caseLabel(view("running", "advocates", 2, 0)), /2 of 4/);
  assert.match(caseLabel(view("running", "judges", 4, 1)), /1 of 3/);
});

test("P0-7: an in-flight history request does not claim the session is empty", () => {
  const label = historyLabel({ isSuccess: false, isError: false });
  assert.doesNotMatch(label, /no cases/i);
  assert.match(label, /loading/i);
});

test("P0-7: only a confirmed success may claim the session is empty", () => {
  // A query waiting between retries is neither actively fetching nor finished,
  // so an in-flight flag cannot decide this. Emptiness is claimed for exactly
  // one flag combination: a successful response.
  const claimsEmpty = (isSuccess: boolean, isError: boolean) =>
    /no cases/i.test(historyLabel({ isSuccess, isError }));
  assert.equal(claimsEmpty(true, false), true, "confirmed success reports the empty history");
  assert.equal(claimsEmpty(false, false), false, "pending, retrying, or paused is not empty");
  assert.equal(claimsEmpty(false, true), false, "a failed request is not empty");
  assert.equal(claimsEmpty(true, true), false, "a reported failure wins over a stale success");
});

test("P0-7: a failed history request does not claim the session is empty", () => {
  const label = historyLabel({ isSuccess: false, isError: true });
  assert.doesNotMatch(label, /no cases/i);
  assert.match(label, /unable/i);
});

test("P0-7: an empty history is reported only after a confirmed successful response", () => {
  assert.match(historyLabel({ isSuccess: true, isError: false }), /no cases/i);
});

test("P0-7: a known failure is never reported as loading", () => {
  assert.match(historyLabel({ isSuccess: false, isError: true }), /unable/i);
});
