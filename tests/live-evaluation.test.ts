import assert from "node:assert/strict";
import test from "node:test";

const SECRET = "sk-or-v1-evaluation-secret-value-never-printed";
process.env.OPENROUTER_API_KEY = SECRET;

const { runEvaluation, planEvaluation } = await import("../src/live/evaluation.js");
const { buildJsonReport, renderMarkdown, stableStringify } = await import("../src/live/report.js");
const { loadFixtures } = await import("../src/live/fixtures.js");
const { indictmentSchema } = await import("../src/schemas.js");
const { textDiversityProxy, jaccardDistance } = await import("../src/live/metrics.js");
const { forbidFetch, stubProvider, TEST_FIXTURE } = await import("./helpers/live.js");

const MODEL = "openai/gpt-4o-mini";
const base = {
  models: [MODEL],
  fixtureIds: [TEST_FIXTURE.id],
  execute: false,
  priceOverride: { inputPerMillion: 1, outputPerMillion: 2 },
};
const deps = (provider: ReturnType<typeof stubProvider>, apiKey = SECRET) =>
  ({ provider, apiKey, fixtures: [TEST_FIXTURE] });

// --- fixtures -------------------------------------------------------------

test("evaluation: every shipped fixture passes production indictment validation", async () => {
  const fixtures = await loadFixtures();
  assert.ok(fixtures.length >= 3, "the corpus should contain several cases");
  const ids = fixtures.map(f => f.id);
  assert.equal(new Set(ids).size, ids.length, "fixture ids must be unique");
  assert.deepEqual(ids, [...ids].sort(), "fixtures load in a stable order");
  for (const fixture of fixtures) {
    assert.doesNotThrow(() => indictmentSchema.parse(fixture.indictment), `${fixture.id} must be a valid indictment`);
    assert.equal(fixture.reference_arguments.length, 4);
    assert.deepEqual(
      fixture.reference_arguments.map(a => a.position),
      ["justified", "justified", "not_justified", "not_justified"],
      `${fixture.id}: reference arguments must follow the fixed stance assignment`);
  }
});

test("evaluation: no fixture encodes an expected verdict", async () => {
  const raw = JSON.stringify(await loadFixtures());
  for (const banned of ["expected_decision", "expected_verdict", "correct_answer", "ground_truth", "expected_position"]) {
    assert.ok(!raw.includes(banned), `fixtures must not record ${banned}`);
  }
});

// --- planning and dry run -------------------------------------------------

test("evaluation: a dry run plans every slot and calls nothing", async () => {
  const guard = forbidFetch();
  try {
    const provider = stubProvider();
    const run = await runEvaluation({ ...base, execute: false }, deps(provider));
    assert.equal(run.mode, "dry-run");
    assert.equal(provider.calls.length, 0);
    assert.equal(guard.called(), 0);
    assert.equal(run.planned.length, 7, "four advocates and three judges per fixture");
    assert.ok(run.plannedMaxCostUsd > 0);
    assert.equal(run.budget, null);
  } finally { guard.restore(); }
});

test("evaluation: a dry run needs no API key", async () => {
  const run = await runEvaluation({ ...base, execute: false }, deps(stubProvider(), ""));
  assert.equal(run.mode, "dry-run");
  assert.equal(run.apiKeyPresent, false);
});

test("evaluation: judges receive the fixed reference evidence, advocates do not", async () => {
  const planned = await planEvaluation({ ...base }, deps(stubProvider()));
  const advocates = planned.filter(call => call.slot.request.role === "advocate");
  const judges = planned.filter(call => call.slot.request.role === "judge");
  assert.equal(advocates.length, 4);
  assert.equal(judges.length, 3);
  for (const call of advocates) {
    assert.ok(!call.slot.request.user.includes("<<<ARGUMENTS_START>>>"));
  }
  const evidence = new Set(judges.map(call => call.slot.request.user));
  assert.equal(evidence.size, 1, "every judge must read byte-identical evidence");
  assert.ok([...evidence][0]!.includes("<<<ARGUMENTS_START>>>"));
});

// --- execution gates ------------------------------------------------------

test("evaluation: execution without a budget or a key is refused before any call", async () => {
  const provider = stubProvider();
  await assert.rejects(
    () => runEvaluation({ ...base, execute: true }, deps(provider)), /--max-cost-usd is required/);
  await assert.rejects(
    () => runEvaluation({ ...base, execute: true, maxCostUsd: 0 }, deps(provider)), /positive number/);
  await assert.rejects(
    () => runEvaluation({ ...base, execute: true, maxCostUsd: 1 }, deps(provider, "  ")), /OPENROUTER_API_KEY is not set/);
  assert.equal(provider.calls.length, 0);
});

test("evaluation: the run stops before the call that would exceed the total budget", async () => {
  // Bill each call at its own conservative estimate, so the approved total is
  // genuinely consumed rather than released again on settle.
  const planned = await planEvaluation({ ...base }, deps(stubProvider()));
  const perCall = planned[0]!.estimate.maxCostUsd;
  const provider = stubProvider([{ costUsd: perCall }]);
  const run = await runEvaluation(
    { ...base, execute: true, maxCostUsd: perCall * 3.5 }, deps(provider));

  assert.equal(run.stoppedReason, "budget_exhausted");
  assert.equal(provider.calls.length, 3, "the fourth call must never be sent");
  assert.equal(run.outcomes.length, 3);
  assert.ok(run.budget!.spentUsd > 0, "cost already incurred is retained in the report");
  assert.ok(run.budget!.spentUsd <= run.budget!.approvedUsd, "settled spend stays inside the approved total");
});

test("evaluation: concurrency cannot reserve more than the approved budget", async () => {
  const planned = await planEvaluation({ ...base }, deps(stubProvider()));
  const perCall = planned[0]!.estimate.maxCostUsd;
  // Four lanes race for a budget that admits at most two concurrent holds.
  const provider = stubProvider([{ costUsd: perCall, delayMs: 5 }]);
  const run = await runEvaluation(
    { ...base, execute: true, maxCostUsd: perCall * 2.5, concurrency: 4 }, deps(provider));

  assert.ok(provider.calls.length <= 2, `at most two calls fit the budget, saw ${provider.calls.length}`);
  assert.equal(run.stoppedReason, "budget_exhausted");
  assert.ok(run.budget!.spentUsd <= run.budget!.approvedUsd, "concurrent holds never overcommit the limit");
});

test("evaluation: a paid invalid response is still counted in spend", async () => {
  const provider = stubProvider([{ body: "not json", costUsd: 0.002 }]);
  const run = await runEvaluation({ ...base, execute: true, maxCostUsd: 100 }, deps(provider));
  assert.equal(run.outcomes.length, 7);
  assert.ok(run.outcomes.every(o => !o.ok), "all responses were malformed");
  assert.ok(Math.abs(run.budget!.spentUsd - 0.014) < 1e-9, `expected 7 x 0.002, got ${run.budget!.spentUsd}`);
});

// --- reports --------------------------------------------------------------

const executedRun = async () => {
  const provider = stubProvider();
  return runEvaluation({ ...base, execute: true, maxCostUsd: 100 }, deps(provider));
};

test("evaluation: JSON and Markdown reports are byte-identical across builds", async () => {
  const run = await executedRun();
  const input = { run, execution: "mocked-verification" as const, generatedAt: "2026-01-01T00:00:00.000Z" };
  const firstJson = stableStringify(buildJsonReport(input));
  const secondJson = stableStringify(buildJsonReport(input));
  assert.equal(firstJson, secondJson, "the JSON report must be deterministic");
  assert.equal(renderMarkdown(buildJsonReport(input)), renderMarkdown(buildJsonReport(input)));
  // Key order is stable regardless of insertion order.
  const keys = Object.keys(JSON.parse(firstJson));
  assert.deepEqual(keys, [...keys].sort());
});

test("evaluation: reports record the metrics the harness promises", async () => {
  const run = await executedRun();
  const report = buildJsonReport({ run, execution: "mocked-verification", generatedAt: "2026-01-01T00:00:00.000Z" }) as any;
  const model = report.models[0];
  assert.equal(model.model, MODEL);
  assert.equal(model.contract.attempted, 7);
  assert.equal(model.contract.successRate, 1);
  assert.equal(model.stance_adherence_rate, 1, "every advocate argued its assigned stance");
  assert.deepEqual(model.decision_distribution, { justified: 2, not_justified: 1, unavailable: 0 });
  const fixture = model.fixtures[0];
  assert.equal(fixture.fixture_id, TEST_FIXTURE.id);
  assert.equal(fixture.judge_texts_compared, 3);
  assert.equal(typeof fixture.judge_text_diversity_proxy, "number");
  const row = fixture.calls[0];
  for (const field of ["prompt_name", "prompt_version", "prompt_hash", "role", "slot", "input_tokens",
    "output_tokens", "cost_usd", "latency_ms", "finish_reason", "contract_layer", "contract_code"]) {
    assert.ok(field in row, `slot rows must record ${field}`);
  }
  assert.equal(report.verdicts_combined, false);
});

test("evaluation: reports never contain reasoning text, prompts, or credentials", async () => {
  const marker = "UNIQUE-REASONING-MARKER-9F3";
  const provider = stubProvider([{
    body: JSON.stringify({ position: "justified", reasoning: `${marker} ${"x".repeat(300)}` }),
  }]);
  // Advocate 3 and 4 are assigned not_justified, so some rows fail; that is fine here.
  const run = await runEvaluation({ ...base, execute: true, maxCostUsd: 100 }, deps(provider));
  const report = buildJsonReport({ run, execution: "mocked-verification", generatedAt: "2026-01-01T00:00:00.000Z" });
  const json = stableStringify(report);
  const markdown = renderMarkdown(report);
  for (const text of [json, markdown]) {
    assert.ok(!text.includes(marker), "model reasoning must never be written to a report");
    assert.ok(!text.includes(SECRET), "the API key must never be written to a report");
    assert.ok(!text.includes("<<<INDICTMENT_START>>>"), "prompt payloads must not be written to a report");
    assert.ok(!/authorization/i.test(text));
  }
  assert.ok(!("reasoningText" in JSON.parse(json)), "no raw text field is emitted");
});

test("evaluation: the report distinguishes dry run, mocked verification, and real execution", async () => {
  const dry = await runEvaluation({ ...base, execute: false }, deps(stubProvider()));
  const dryReport = buildJsonReport({ run: dry, execution: "dry-run", generatedAt: "t" }) as any;
  assert.equal(dryReport.execution, "dry-run");
  assert.equal(dryReport.mode, "dry-run");
  assert.match(renderMarkdown(dryReport), /No model request was sent/);

  const run = await executedRun();
  const mocked = buildJsonReport({ run, execution: "mocked-verification", generatedAt: "t" }) as any;
  assert.equal(mocked.execution, "mocked-verification");
  assert.match(renderMarkdown(mocked), /mocked-verification/);

  const real = buildJsonReport({ run, execution: "real-execution", generatedAt: "t" }) as any;
  assert.equal(real.execution, "real-execution");
});

test("evaluation: the report computes no combined verdict", async () => {
  const run = await executedRun();
  const text = stableStringify(buildJsonReport({ run, execution: "mocked-verification", generatedAt: "t" }))
    + renderMarkdown(buildJsonReport({ run, execution: "mocked-verification", generatedAt: "t" }));
  for (const banned of ["majority", "consensus", "winner", "combined_verdict", "merged_verdict", "final_verdict", "prevailing"]) {
    const keyLike = new RegExp(`"[^"]*${banned}[^"]*"\\s*:`, "i");
    assert.ok(!keyLike.test(text), `no report key may contain ${banned}`);
  }
});

// --- metrics --------------------------------------------------------------

test("evaluation: the diversity proxy is deterministic and bounded", () => {
  assert.equal(jaccardDistance("alpha beta gamma", "alpha beta gamma"), 0);
  assert.equal(jaccardDistance("alpha beta", "gamma delta"), 1);
  const texts = ["duty and rules matter here", "consequences and costs matter here", "intent and character matter here"];
  const first = textDiversityProxy(texts);
  assert.equal(first, textDiversityProxy(texts), "the proxy must be deterministic");
  assert.ok(first !== null && first > 0 && first < 1);
  assert.equal(textDiversityProxy(["only one"]), null, "a single text has no pairwise distance");
});
