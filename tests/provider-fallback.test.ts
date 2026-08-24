import assert from "node:assert/strict";
import test from "node:test";

process.env.OPENROUTER_API_KEY = "test-key-not-real";
process.env.STRUCTURED_OUTPUT = "json_schema";
const { OpenRouterProvider } = await import("../src/providers.js");

const request = {
  role: "judge" as const, instance: 1, stance: null,
  system: "system", user: "user", model: "test/model",
  maxOutputTokens: 1200, timeoutMs: 5000, temperature: 0.2,
};
const ok = {
  choices: [{ message: { content: JSON.stringify({ decision: "justified", reasoning: "x".repeat(400) }) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 80, cost: 0.001 }, model: "test/model",
};

function stubFetch(responses: { status: number; body: unknown }[]) {
  const bodies: any[] = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const next = responses[Math.min(index++, responses.length - 1)]!;
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as unknown as Response;
  }) as typeof fetch;
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

test("model without strict schemas receives one compatible-mode fallback", async () => {
  const stub = stubFetch([
    { status: 400, body: { error: { message: "Provider does not support response_format json_schema" } } },
    { status: 200, body: ok },
  ]);
  try {
    const result = await new OpenRouterProvider().complete(request);
    assert.equal(stub.bodies.length, 2, "expected exactly one retry");
    assert.equal(stub.bodies[0].response_format.type, "json_schema");
    assert.equal(stub.bodies[1].response_format.type, "json_object", "fallback must use compatible mode");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.costUsd, 0.001);
  } finally { stub.restore(); }
});

test("an unrelated 400 response does not trigger a format fallback", async () => {
  const stub = stubFetch([{ status: 400, body: { error: { message: "context length exceeded" } } }]);
  try {
    await assert.rejects(() => new OpenRouterProvider().complete(request), /context length exceeded/);
    assert.equal(stub.bodies.length, 1, "an unrelated 400 must not trigger a retry");
  } finally { stub.restore(); }
});

test("an API-key failure is non-retryable", async () => {
  const stub = stubFetch([{ status: 401, body: { error: { message: "invalid api key" } } }]);
  try {
    const { isRetryable } = await import("../src/schemas.js");
    const error = await new OpenRouterProvider().complete(request).then(() => null, e => e);
    assert.ok(error, "expected an error");
    assert.equal(isRetryable(error), false);
    assert.equal(stub.bodies.length, 1);
  } finally { stub.restore(); }
});
