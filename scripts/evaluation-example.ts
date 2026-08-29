/**
 * Regenerate the tracked synthetic evaluation example.
 *
 * The example exists so the report format can be reviewed without anyone
 * spending money. It is produced by a deterministic stub provider and a fixed
 * timestamp, never by a paid call, and is labelled `mocked-verification` so it
 * can never be mistaken for a real measurement.
 *
 *   npm run eval:example
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { runEvaluation } from "../src/live/evaluation.js";
import { buildJsonReport, renderMarkdown, stableStringify } from "../src/live/report.js";
import type { ModelProvider, ModelRequest, ModelResult } from "../src/types.js";

const OUT_DIR = path.join("evaluation", "example");
const GENERATED_AT = "2026-01-01T00:00:00.000Z";

/**
 * Distinct vocabulary per judge lens, so the example shows a non-trivial
 * diversity proxy instead of a degenerate zero.
 */
const LENS_WORDS: Record<number, string> = {
  1: "duty obligation rule promise commitment standard binding requirement",
  2: "consequence outcome harm benefit cost tradeoff impact magnitude",
  3: "intent motive character disposition sincerity candour restraint judgement",
};

/** Deterministic responses: no randomness, no network, no cost. */
function exampleProvider(model: string): ModelProvider {
  const reasoning = (seed: string, vocabulary = "") =>
    `${seed} ${vocabulary} This synthetic reasoning exists only to exercise the report format. `.repeat(4)
      .padEnd(320, " It contains no model output and no personal data.");
  return {
    async complete(request: ModelRequest): Promise<ModelResult> {
      // One deliberate contract failure per model shows how failures are reported.
      const failing = request.role === "advocate" && request.instance === 4;
      const body = failing
        ? "{ not valid json"
        : request.role === "advocate"
          ? JSON.stringify({ position: request.stance, reasoning: reasoning(`advocate ${request.instance}`) })
          : JSON.stringify({
            decision: request.instance === 2 ? "not_justified" : "justified",
            reasoning: reasoning(`judge ${request.instance} lens`, LENS_WORDS[request.instance] ?? ""),
          });
      return {
        rawBody: body,
        finishReason: "stop",
        provider: "synthetic",
        model: `${model}-synthetic`,
        inputTokens: 1200 + request.instance * 10,
        outputTokens: 320 + request.instance * 5,
        costUsd: 0.0004,
        latencyMs: 900 + request.instance * 25,
      };
    },
  };
}

const model = "example/synthetic-model";
const run = await runEvaluation(
  {
    models: [model],
    execute: true,
    maxCostUsd: 5,
    priceOverrides: { [model]: { inputPerMillion: 0.5, outputPerMillion: 1.5 } },
  },
  { provider: exampleProvider(model), apiKey: "synthetic-not-a-real-key" },
);

const report = buildJsonReport({ run, execution: "mocked-verification", generatedAt: GENERATED_AT });
await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "example-report.json"), stableStringify(report), "utf8");
await writeFile(path.join(OUT_DIR, "example-report.md"), renderMarkdown(report), "utf8");
console.log(`Wrote the synthetic example to ${OUT_DIR}. No model was called and no cost was incurred.`);
