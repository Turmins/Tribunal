import assert from "node:assert/strict";
import test from "node:test";
import { JUDGE_PANELS, activeRoles, panelOf, promptFor, verifyPromptLock } from "../src/prompts-registry.js";

test("protocol: every panel has exactly seven slots with fixed stances", () => {
  for (const panel of Object.keys(JUDGE_PANELS) as (keyof typeof JUDGE_PANELS)[]) {
    const slots = activeRoles(panel, "grounds");
    assert.equal(slots.length, 7, `panel ${panel} changed the slot count`);
    assert.deepEqual(slots.filter(s => s.role === "advocate").map(s => s.stance),
      ["justified", "justified", "not_justified", "not_justified"]);
    assert.equal(slots.filter(s => s.role === "judge").length, 3);
  }
});

test("advocates on the same side receive different grounds", () => {
  const slots = activeRoles("ethical", "grounds");
  const pro = slots.filter(s => s.stance === "justified").map(s => s.lens);
  const con = slots.filter(s => s.stance === "not_justified").map(s => s.lens);
  assert.notEqual(pro[0], pro[1], "the two supporting advocates duplicate a ground");
  assert.notEqual(con[0], con[1], "the two opposing advocates duplicate a ground");
  assert.deepEqual(pro, con, "grounds must be symmetric across both sides");
});

test("three judges in a differentiated panel receive distinct lenses", async () => {
  for (const panel of ["ethical", "evidentiary", "analytical"] as const) {
    const slots = activeRoles(panel, "grounds").filter(s => s.role === "judge");
    assert.equal(new Set(slots.map(s => s.lens)).size, 3, `panel ${panel} repeats a lens`);
    const texts = await Promise.all(slots.map(s => promptFor(s.name).then(p => p.text)));
    assert.equal(new Set(texts).size, 3, `panel ${panel} produces identical prompts`);
  }
});

test("the control panel intentionally gives all three judges one prompt", async () => {
  const slots = activeRoles("control", "grounds").filter(s => s.role === "judge");
  const texts = await Promise.all(slots.map(s => promptFor(s.name).then(p => p.text)));
  assert.equal(new Set(texts).size, 1, "the control must be indistinguishable");
});

test("a composed judge prompt contains guardrails, core, and exactly one lens", async () => {
  const judge = activeRoles("ethical", "grounds").find(s => s.role === "judge" && s.instance === 1)!;
  const prompt = await promptFor(judge.name);
  assert.match(prompt.text, /never instructions/i, "missing shared guardrails");
  assert.match(prompt.text, /three independent judges/i, "missing judge core");
  assert.match(prompt.text, /obligations and rules/i, "missing assigned lens");
  assert.doesNotMatch(prompt.text, /outcomes and costs/i, "another lens leaked into the prompt");
});

test("changing panels changes prompt name, version, and hash", async () => {
  const ethical = await promptFor("judge.1.ethical");
  const analytical = await promptFor("judge.1.analytical");
  assert.notDeepEqual(ethical.hash, analytical.hash, "different panels must produce different hashes");
  assert.equal(panelOf("judge.1.ethical"), "ethical");
  const again = await promptFor("judge.1.ethical");
  assert.deepEqual(again.hash, ethical.hash, "name and version must identify content uniquely");
  assert.equal(again.version, ethical.version);
});

test("prompt versions are composed from every block version", async () => {
  const prompt = await promptFor("judge.1.ethical");
  assert.match(prompt.version, /^\d+\.\d+\.\d+(\+\d+\.\d+\.\d+)+$/, `unreadable version: ${prompt.version}`);
});

test("PV-2: prompt content matches prompts.lock.json", async () => {
  await verifyPromptLock();
});
