import assert from "node:assert/strict";
import test from "node:test";

// Set before importing configuration: the canary must read the key from the
// environment only, and this file also asserts the value never reaches output.
const SECRET = "sk-or-v1-canary-secret-value-must-never-be-printed";
process.env.OPENROUTER_API_KEY = SECRET;

const { runCanary, planCanary, MAX_CANARY_CALLS } = await import("../src/live/canary.js");
const { forbidFetch, stubProvider, advocateBody, TEST_FIXTURE } = await import("./helpers/live.js");

const OPTIONS = {
  role: "advocate" as const,
  instance: 1,
  model: "openai/gpt-4o-mini",
  fixtureId: TEST_FIXTURE.id,
  execute: false,
  maxCostUsd: undefined as number | undefined,
};
const deps = (provider: ReturnType<typeof stubProvider>, apiKey = SECRET) =>
  ({ provider, apiKey, fixtures: [TEST_FIXTURE] });

test("canary: a dry run performs no model call and no network call", async () => {
  const guard = forbidFetch();
  try {
    const provider = stubProvider();
    const report = await runCanary({ ...OPTIONS, execute: false }, deps(provider));
    assert.equal(provider.calls.length, 0, "dry run must not call the provider");
    assert.equal(guard.called(), 0, "dry run must not touch the network");
    assert.equal(report.plan.networkCallPerformed, false);
    assert.equal(report.outcome, null);
    assert.equal(report.callCount, 0);
    assert.ok(report.plan.estimate.maxCostUsd > 0, "a dry run still produces a cost ceiling");
  } finally { guard.restore(); }
});

test("canary: planCanary can never execute even if execute is requested", async () => {
  const provider = stubProvider();
  const report = await planCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(provider.calls.length, 0);
  assert.equal(report.plan.mode, "dry-run");
});

test("canary: execution without --execute never calls the provider", async () => {
  const provider = stubProvider();
  // A limit alone must not be enough to spend money.
  const report = await runCanary({ ...OPTIONS, execute: false, maxCostUsd: 10 }, deps(provider));
  assert.equal(provider.calls.length, 0);
  assert.equal(report.plan.mode, "dry-run");
});

test("canary: execution without an approved limit is refused before any call", async () => {
  const provider = stubProvider();
  await assert.rejects(
    () => runCanary({ ...OPTIONS, execute: true, maxCostUsd: undefined }, deps(provider)),
    /budget_required|--max-cost-usd is required/);
  assert.equal(provider.calls.length, 0);
});

test("canary: an invalid limit is refused before any call", async () => {
  const provider = stubProvider();
  for (const bad of [0, -1, Number.NaN]) {
    await assert.rejects(
      () => runCanary({ ...OPTIONS, execute: true, maxCostUsd: bad }, deps(provider)),
      /positive number/);
  }
  assert.equal(provider.calls.length, 0);
});

test("canary: execution without an API key is refused before any call", async () => {
  const provider = stubProvider();
  await assert.rejects(
    () => runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider, "   ")),
    /OPENROUTER_API_KEY is not set/);
  assert.equal(provider.calls.length, 0, "a missing key must stop the call, not fail inside the provider");
});

test("canary: an estimate above the approved limit blocks the call", async () => {
  const provider = stubProvider();
  const plan = await runCanary({ ...OPTIONS, execute: false }, deps(provider));
  const tooSmall = plan.plan.estimate.maxCostUsd / 2;
  await assert.rejects(
    () => runCanary({ ...OPTIONS, execute: true, maxCostUsd: tooSmall }, deps(provider)),
    /exceeds the approved limit/);
  assert.equal(provider.calls.length, 0, "no request may be sent when the estimate does not fit");
});

test("canary: a permitted run issues at most one model request", async () => {
  const provider = stubProvider();
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(provider.calls.length, 1, "the canary is limited to a single request");
  assert.equal(report.callCount, 1);
  assert.equal(MAX_CANARY_CALLS, 1);
  assert.equal(report.plan.networkCallPerformed, true);
});

test("canary: a valid response passes the production validator", async () => {
  const provider = stubProvider([{ body: advocateBody("justified", "reasoned argument") }]);
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(report.outcome?.ok, true);
  assert.equal(report.outcome?.contract.valid, true);
  assert.equal(report.outcome?.stanceAdherence, true, "advocate 1 is assigned justified");
  assert.ok((report.outcome?.reasoningLength ?? 0) >= 200);
});

test("canary: the request is built from the production prompt registry", async () => {
  const provider = stubProvider();
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  const sent = provider.calls[0]!;
  assert.equal(report.plan.promptName, "advocate.1.ex_ante");
  assert.match(report.plan.promptVersion, /^\d+\.\d+\.\d+(\+\d+\.\d+\.\d+)+$/);
  assert.equal(report.plan.promptHash.length, 64, "sha256 hex digest");
  assert.ok(sent.user.includes("<<<INDICTMENT_START>>>"), "the indictment must stay inside the data wrapper");
  assert.ok(!sent.user.includes("<<<ARGUMENTS_START>>>"), "an advocate receives no judge evidence block");
  assert.equal(sent.stance, "justified");
});

test("canary: malformed output stays a failure and is never turned into a result", async () => {
  const cases: { body: string; layer: string }[] = [
    { body: "not json at all", layer: "L1" },
    { body: JSON.stringify({ position: "justified" }), layer: "L2" },
    { body: JSON.stringify({ position: "maybe", reasoning: "x".repeat(300) }), layer: "L3" },
    { body: JSON.stringify({ position: "justified", reasoning: "too short" }), layer: "L4" },
    { body: JSON.stringify({ position: "not_justified", reasoning: "x".repeat(300) }), layer: "L5" },
    { body: JSON.stringify({ decision: "justified", reasoning: "x".repeat(300) }), layer: "L6" },
  ];
  for (const entry of cases) {
    const provider = stubProvider([{ body: entry.body }]);
    const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
    assert.equal(report.outcome?.ok, false, `${entry.layer} must fail`);
    assert.equal(report.outcome?.contract.layer, entry.layer);
    assert.equal(report.outcome?.decision, null, "a failure never carries a decision");
    assert.equal(report.outcome?.stanceAdherence, null);
  }
});

test("canary: a truncated response is a transport failure, not a short answer", async () => {
  const provider = stubProvider([{ finishReason: "length" }]);
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(report.outcome?.ok, false);
  assert.equal(report.outcome?.contract.code, "truncated_response");
});

test("canary: a paid but invalid response still counts toward spend", async () => {
  const provider = stubProvider([{ body: "not json", costUsd: 0.004 }]);
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(report.outcome?.ok, false);
  assert.equal(report.outcome?.costUsd, 0.004);
  assert.equal(report.budget?.spentUsd, 0.004, "an invalid answer was still paid for");
});

test("canary: a provider failure records an error and spends nothing", async () => {
  const provider = stubProvider([{ fail: "connection reset" }]);
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(report.outcome?.ok, false);
  assert.equal(report.outcome?.errorCode, "provider_error");
  assert.equal(report.budget?.spentUsd, 0);
});

test("canary: the format fallback is reported when the provider used it", async () => {
  const provider = stubProvider([{ formatFallback: true, httpAttempts: 2 }]);
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(report.outcome?.formatFallback, true);
  assert.equal(report.outcome?.httpAttempts, 2);
});

test("canary: the estimate covers a possible format-fallback retry", async () => {
  const report = await runCanary({ ...OPTIONS, execute: false }, deps(stubProvider()));
  const estimate = report.plan.estimate;
  assert.equal(estimate.formatFallbackIncluded, true, "json_schema mode may retry once");
  assert.ok(Math.abs(estimate.maxCostUsd - estimate.singleCallUsd * 2) < 1e-9);
});

test("canary: judges are refused because they require the full protocol", async () => {
  await assert.rejects(
    () => runCanary({ ...OPTIONS, role: "judge" as never, execute: false }, deps(stubProvider())),
    /supports only: advocate/);
});

test("canary: an unpriced model cannot be estimated and therefore cannot run", async () => {
  await assert.rejects(
    () => runCanary({ ...OPTIONS, model: "vendor/unknown-model", execute: false }, deps(stubProvider())),
    /unknown_model_price/);
});

test("canary: explicit prices allow an otherwise unpriced model to be estimated", async () => {
  const report = await runCanary(
    { ...OPTIONS, model: "vendor/unknown-model", execute: false, priceOverride: { inputPerMillion: 1, outputPerMillion: 2 } },
    deps(stubProvider()));
  assert.equal(report.plan.estimate.priceSource, "explicit_override");
  assert.ok(report.plan.estimate.maxCostUsd > 0);
});

test("canary: the API key never appears in any rendered output", async () => {
  const { formatCanary } = await import("../src/live/canary.js");
  const provider = stubProvider([{ body: "not json", costUsd: 0.001 }]);
  const executed = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  const planned = await runCanary({ ...OPTIONS, execute: false }, deps(stubProvider()));
  for (const report of [executed, planned]) {
    const rendered = formatCanary(report);
    assert.ok(!rendered.includes(SECRET), "the key must never be rendered");
    assert.ok(!/authorization/i.test(rendered), "no Authorization header may be shown");
    assert.ok(!rendered.includes(JSON.stringify(report.plan.promptHash) + "prompt"), "no prompt body is printed");
  }
  // The composed prompt text itself must not be echoed either.
  assert.ok(!formatCanary(executed).includes("<<<INDICTMENT_START>>>"));
});

test("canary: the rendered summary contains no raw model response", async () => {
  const { formatCanary } = await import("../src/live/canary.js");
  const marker = "RAW-MODEL-PROSE-MARKER";
  const provider = stubProvider([{ body: JSON.stringify({ position: "justified", reasoning: `${marker} ${"x".repeat(300)}` }) }]);
  const report = await runCanary({ ...OPTIONS, execute: true, maxCostUsd: 10 }, deps(provider));
  assert.equal(report.outcome?.ok, true);
  assert.ok(!formatCanary(report).includes(marker), "reasoning text must not be printed");
});
