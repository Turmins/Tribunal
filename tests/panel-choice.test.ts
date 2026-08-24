import assert from "node:assert/strict";
import test from "node:test";
import { createCaseSchema } from "../src/schemas.js";
import { SELECTABLE_PANELS, selectablePanels } from "../src/prompts-registry.js";

const indictment = {
  defendant: "Test defendant",
  act: "Made a test decision with consequences for the team",
  question: "Was this decision justified?",
};

test("panel selection: accepted values pass validation", () => {
  for (const panel of SELECTABLE_PANELS) {
    assert.equal(createCaseSchema.parse({ indictment, panel }).panel, panel);
  }
});

test("panel selection: the field is optional", () => {
  assert.equal(createCaseSchema.parse({ indictment }).panel, undefined);
});

test("panel selection: the control panel is unavailable to users", () => {
  assert.throws(() => createCaseSchema.parse({ indictment, panel: "control" }),
    "control is an evaluation baseline, not a product mode");
  assert.ok(!(SELECTABLE_PANELS as readonly string[]).includes("control"));
});

test("panel selection: arbitrary values are rejected", () => {
  assert.throws(() => createCaseSchema.parse({ indictment, panel: "../../etc/passwd" }));
  assert.throws(() => createCaseSchema.parse({ indictment, panel: "judge.1.ethical" }));
});

test("panel selection: descriptions come from the server instead of client hardcoding", () => {
  const panels = selectablePanels();
  assert.equal(panels.length, SELECTABLE_PANELS.length);
  for (const panel of panels) {
    assert.ok(panel.name && panel.title && panel.summary, `panel ${panel.name} is incomplete`);
    assert.equal(panel.lenses.length, 3, `panel ${panel.name} must contain three lenses`);
    for (const lens of panel.lenses) assert.ok(lens.length > 0);
  }
  assert.ok(!panels.some(p => (p.name as string) === "control"));
});
