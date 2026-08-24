import assert from "node:assert/strict";
import test from "node:test";
import { caseLabel } from "../client/src/labels.js";

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
