import type { Fixture } from "../../src/live/fixtures.js";
import type { ModelProvider, ModelRequest, ModelResult } from "../../src/types.js";

/**
 * Test doubles for the guarded live tools.
 *
 * Every test in this area uses a stub provider. No test may reach OpenRouter, so
 * the stub replaces the provider interface entirely rather than intercepting
 * HTTP, and `forbidFetch()` additionally fails any test that tries to use the
 * network by another route.
 */

export interface StubStep {
  readonly body?: string;
  readonly fail?: string;
  readonly finishReason?: string;
  readonly costUsd?: number;
  readonly costSource?: "provider" | "table" | "unknown";
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly formatFallback?: boolean;
  readonly httpAttempts?: number;
  /** Milliseconds of simulated latency, used to interleave concurrent calls. */
  readonly delayMs?: number;
}

export interface StubProvider extends ModelProvider {
  readonly calls: ModelRequest[];
}

const longReasoning = (seed: string): string =>
  `${seed} `.repeat(40).trim().padEnd(260, " filler words for contract length");

export function advocateBody(position: string, seed = "argument"): string {
  return JSON.stringify({ position, reasoning: longReasoning(seed) });
}

export function judgeBody(decision: string, seed = "decision"): string {
  return JSON.stringify({ decision, reasoning: longReasoning(seed) });
}

/**
 * Provider stub. `steps` are consumed in order; the last one repeats so a test
 * can describe "first call fails, everything after succeeds" compactly.
 */
export function stubProvider(steps: readonly StubStep[] = []): StubProvider {
  const calls: ModelRequest[] = [];
  let index = 0;
  return {
    calls,
    async complete(request: ModelRequest): Promise<ModelResult> {
      calls.push(request);
      const step = steps[Math.min(index, steps.length - 1)] ?? {};
      index += 1;
      if (step.delayMs) await new Promise(resolve => setTimeout(resolve, step.delayMs));
      if (step.fail) throw new Error(step.fail);
      const body = step.body ?? (request.role === "advocate"
        ? advocateBody(request.stance ?? "justified", `advocate ${request.instance}`)
        : judgeBody(request.instance === 2 ? "not_justified" : "justified", `judge ${request.instance}`));
      const result: ModelResult = {
        rawBody: body,
        finishReason: step.finishReason ?? "stop",
        provider: "stub",
        model: `${request.model}-resolved`,
        inputTokens: step.inputTokens ?? 1000,
        outputTokens: step.outputTokens ?? 300,
        costUsd: step.costUsd ?? 0.0005,
        latencyMs: 12,
      };
      if (step.costSource !== undefined) result.costSource = step.costSource;
      if (step.httpAttempts !== undefined) (result as { httpAttempts?: number }).httpAttempts = step.httpAttempts;
      if (step.formatFallback !== undefined) (result as { formatFallback?: boolean }).formatFallback = step.formatFallback;
      return result;
    },
  };
}

/** Fails the test if anything attempts a network call. */
export function forbidFetch(): { restore: () => void; called: () => number } {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async () => {
    count += 1;
    throw new Error("network access is forbidden in tests");
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, called: () => count };
}

const reference = (instance: number, position: string, word: string) => ({
  instance_no: instance,
  position: position as "justified" | "not_justified",
  reasoning: `${word} `.repeat(45).trim().padEnd(240, " additional reference text for the fixed evidence block"),
});

/** Minimal in-memory fixture so tests do not depend on the shipped corpus. */
export const TEST_FIXTURE: Fixture = {
  id: "test-fixture-alpha",
  label: "Test fixture",
  domain: "testing",
  ambiguity: "balanced",
  note: "Synthetic fixture used only by the automated tests.",
  indictment: {
    defendant: "A test operations team",
    act: "Deployed a configuration change outside the agreed maintenance window to restore a degraded service",
    question: "Was the out-of-window deployment justified?",
  },
  reference_arguments: [
    reference(1, "justified", "alpha"),
    reference(2, "justified", "beta"),
    reference(3, "not_justified", "gamma"),
    reference(4, "not_justified", "delta"),
  ],
};
