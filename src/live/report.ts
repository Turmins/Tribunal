import { round } from "./budget.js";
import type { EvaluationRun } from "./evaluation.js";
import { contractStats, round4, sortKeys, stanceAdherenceRate, textDiversityProxy } from "./metrics.js";
import type { GuardedOutcome } from "./run.js";

/**
 * Deterministic evaluation reports.
 *
 * Two rules shape everything here:
 *
 * 1. Nothing model-authored is written to disk. Reports carry derived numbers —
 *    counts, rates, lengths, costs — never reasoning text, never a raw response,
 *    never a prompt body. Storing model prose would turn a metrics file into an
 *    uncontrolled copy of provider output.
 * 2. The output is reproducible. Keys are emitted in sorted order, rows are
 *    sorted by a stable key, and the only non-deterministic value, the
 *    timestamp, is injected by the caller rather than read from the clock.
 */

export const REPORT_FORMAT = "tribunal-evaluation/1.1.0";

/**
 * How the numbers were produced. A report that cannot distinguish a planned run
 * from a stubbed one from a paid one is worse than no report.
 */
export type ExecutionKind = "dry-run" | "mocked-verification" | "execution-blocked" | "real-execution";

export interface ReportInput {
  readonly run: EvaluationRun;
  readonly execution: ExecutionKind;
  /** Injected so the report is byte-stable for a given set of outcomes. */
  readonly generatedAt: string;
}

export interface JsonReport { readonly [key: string]: unknown }

const numbers = (values: readonly number[]) => {
  if (values.length === 0) return { count: 0, min: null, max: null, mean: null, total: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round4(total / values.length),
    total: round(total),
  };
};

const tally = (values: readonly (string | null)[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "unknown";
    out[key] = (out[key] ?? 0) + 1;
  }
  return sortKeys(out);
};

function slotRow(outcome: GuardedOutcome, fixtureId: string): JsonReport {
  return {
    contract_code: outcome.contract.code,
    contract_layer: outcome.contract.layer,
    contract_valid: outcome.contract.valid,
    cost_basis: outcome.costBasis,
    cost_uncertain: outcome.costUncertain,
    cost_usd: outcome.costUsd,
    decision: outcome.decision,
    estimated_max_cost_usd: outcome.estimatedMaxCostUsd,
    finish_reason: outcome.finishReason,
    fixture_id: fixtureId,
    format_fallback: outcome.formatFallback,
    http_attempts: outcome.httpAttempts,
    input_tokens: outcome.inputTokens,
    instance: outcome.instance,
    latency_ms: outcome.latencyMs,
    output_tokens: outcome.outputTokens,
    prompt_hash: outcome.promptHash,
    prompt_name: outcome.promptName,
    prompt_version: outcome.promptVersion,
    reasoning_length: outcome.reasoningLength,
    reported_model: outcome.reportedModel,
    role: outcome.role,
    slot: outcome.slot,
    stance_adherence: outcome.stanceAdherence,
    stance_assigned: outcome.assignedStance,
    succeeded: outcome.ok,
  };
}

export function buildJsonReport(input: ReportInput): JsonReport {
  const { run } = input;
  const paired = run.outcomes.map((outcome, index) => ({
    outcome,
    fixtureId: run.outcomeFixtures[index] ?? "unknown",
  }));

  const models = [...run.models].sort().map(model => {
    const forModel = paired.filter(entry => entry.outcome.requestedModel === model);
    const outcomes = forModel.map(entry => entry.outcome);
    const fixtures = [...new Set(forModel.map(entry => entry.fixtureId))].sort().map(fixtureId => {
      const rows = forModel.filter(entry => entry.fixtureId === fixtureId);
      const judgeTexts = rows
        .filter(entry => entry.outcome.role === "judge" && entry.outcome.reasoningText)
        .map(entry => entry.outcome.reasoningText!);
      return {
        calls: rows
          .map(entry => slotRow(entry.outcome, entry.fixtureId))
          .sort((a, b) => String(a["slot"]).localeCompare(String(b["slot"]))),
        contract: contractStats(rows.map(entry => entry.outcome)),
        fixture_id: fixtureId,
        judge_text_diversity_proxy: textDiversityProxy(judgeTexts),
        judge_texts_compared: judgeTexts.length,
      };
    });

    const plannedForModel = run.planned.filter(call => call.model === model);
    return {
      contract: contractStats(outcomes),
      cost_usd: round(outcomes.reduce((sum, o) => sum + o.costUsd, 0)),
      planned_calls: plannedForModel.length,
      planned_max_cost_usd: round(plannedForModel.reduce((sum, call) => sum + call.estimate.maxCostUsd, 0)),
      finish_reasons: tally(outcomes.map(o => o.finishReason)),
      fixtures,
      format_fallback_count: outcomes.filter(o => o.formatFallback === true).length,
      http_attempts_total: outcomes.reduce((sum, o) => sum + (o.httpAttempts ?? 0), 0),
      input_tokens: numbers(outcomes.map(o => o.inputTokens)),
      latency_ms: numbers(outcomes.filter(o => o.latencyMs !== null).map(o => o.latencyMs!)),
      model,
      output_tokens: numbers(outcomes.map(o => o.outputTokens)),
      stance_adherence_rate: stanceAdherenceRate(outcomes),
    };
  });

  return {
    budget: run.budget,
    diversity_proxy_note:
      "judge_text_diversity_proxy is mean pairwise Jaccard distance over judge reasoning vocabulary. It measures word overlap only and is not evidence of reasoning quality or of genuine lens differentiation.",
    execution: input.execution,
    fixtures_evaluated: [...run.fixtureIds].sort(),
    generated_at: input.generatedAt,
    models,
    mode: run.mode,
    planned: {
      calls: run.planned.length,
      conservative_max_cost_usd: run.plannedMaxCostUsd,
    },
    provider_calls: run.callCount,
    report_format: REPORT_FORMAT,
    roles_evaluated: [...run.roles].sort(),
    stopped_reason: run.stoppedReason,
    structured_output_mode: run.structuredOutputMode,
  };
}

/** JSON with deterministically ordered keys. */
export function stableStringify(value: unknown, indent = 2): string {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return node;
  };
  return `${JSON.stringify(normalize(value), null, indent)}\n`;
}

const pct = (value: unknown): string =>
  typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "n/a";
const money = (value: unknown): string =>
  typeof value === "number" ? `$${value.toFixed(6)}` : "n/a";

const HOW_TO_READ: readonly string[] = [
  "## How to read these numbers",
  "",
  "- **Contract pass** is the share of calls whose output satisfied the production validator. It says nothing about whether the reasoning was good.",
  "- **Stance adherence** applies to advocates only: it is the share of validated advocates that argued the stance the protocol assigned.",
  "- **Judge decisions** remain individual call records. The report does not derive panel-level decision counts or a preferred result.",
  "- **Diversity proxy** is the mean pairwise Jaccard distance between judge reasoning vocabularies. It is a proxy for wording difference, not evidence of reasoning quality or of real lens differentiation. Two judges can reason very differently in similar words, and boilerplate rephrasing can score high. Use it only to decide which outputs deserve a human read.",
  "",
  "No model was used to grade another model. Every number above is fixed arithmetic over recorded run outcomes.",
];

export function renderMarkdown(report: JsonReport): string {
  const models = (report["models"] as JsonReport[] | undefined) ?? [];
  const planned = report["planned"] as { calls: number; conservative_max_cost_usd: number };
  const budget = report["budget"] as { approvedUsd: number; spentUsd: number; remainingUsd: number; overrun: boolean } | null;
  const lines: string[] = [];

  lines.push("# Tribunal model evaluation");
  lines.push("");
  lines.push(`- Report format: \`${report["report_format"]}\``);
  lines.push(`- Generated at: ${report["generated_at"]}`);
  lines.push(`- Execution: **${report["execution"]}**`);
  lines.push(`- Mode: \`${report["mode"]}\``);
  lines.push(`- Structured output: \`${report["structured_output_mode"]}\``);
  lines.push(`- Planned calls: ${planned.calls} (conservative maximum ${money(planned.conservative_max_cost_usd)})`);
  lines.push(`- Provider calls attempted: ${report["provider_calls"]}`);
  lines.push(`- Fixtures: ${(report["fixtures_evaluated"] as string[]).join(", ")}`);
  if (report["stopped_reason"]) lines.push(`- Stopped early: \`${report["stopped_reason"]}\``);
  if (budget) {
    lines.push(`- Budget: approved ${money(budget.approvedUsd)}, spent ${money(budget.spentUsd)}, remaining ${money(budget.remainingUsd)}${budget.overrun ? " **OVERRUN**" : ""}`);
  }
  lines.push("");

  // With no outcomes there is nothing to summarise; describe the planned work instead
  // of printing empty result tables.
  const hasOutcomes = models.some(model => (model["contract"] as { attempted: number }).attempted > 0);
  if (!hasOutcomes) {
    lines.push(report["execution"] === "dry-run"
      ? "No model request was sent. This report describes the planned work and its conservative cost ceiling only."
      : report["execution"] === "execution-blocked"
        ? "Execution was blocked before the provider was called. Only the planned work is described below."
        : "No call produced an outcome, so only the planned work is described below.");
    lines.push("");
    lines.push("## Planned work");
    lines.push("");
    lines.push("| Model | Planned calls | Conservative maximum |");
    lines.push("| --- | ---: | ---: |");
    for (const model of models) {
      lines.push(`| \`${model["model"]}\` | ${model["planned_calls"]} | ${money(model["planned_max_cost_usd"])} |`);
    }
    lines.push("");
    lines.push(`Roles evaluated: ${(report["roles_evaluated"] as string[]).join(", ")}. Each planned call is one role slot on one fixture.`);
    lines.push("");
    lines.push(...HOW_TO_READ);
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Per-model summary");
  lines.push("");
  lines.push("| Model | Contract pass | Stance adherence | Input tok | Output tok | Cost | Fallbacks |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const model of models) {
    const contract = model["contract"] as { successRate: number | null; valid: number; attempted: number };
    const input = model["input_tokens"] as { total: number };
    const output = model["output_tokens"] as { total: number };
    lines.push(
      `| \`${model["model"]}\` | ${pct(contract.successRate)} (${contract.valid}/${contract.attempted}) | ${pct(model["stance_adherence_rate"])} | ${input.total} | ${output.total} | ${money(model["cost_usd"])} | ${model["format_fallback_count"]} |`,
    );
  }
  lines.push("");

  for (const model of models) {
    lines.push(`## \`${model["model"]}\``);
    lines.push("");
    const contract = model["contract"] as { failures: Record<string, number> };
    const failures = Object.entries(contract.failures);
    if (failures.length) {
      lines.push("Validation failures by layer and code:");
      lines.push("");
      for (const [key, count] of failures) lines.push(`- \`${key}\`: ${count}`);
      lines.push("");
    }
    lines.push("| Fixture | Contract pass | Diversity proxy |");
    lines.push("| --- | ---: | ---: |");
    for (const fixture of (model["fixtures"] as JsonReport[])) {
      const c = fixture["contract"] as { successRate: number | null };
      const proxy = fixture["judge_text_diversity_proxy"];
      lines.push(
        `| \`${fixture["fixture_id"]}\` | ${pct(c.successRate)} | ${typeof proxy === "number" ? proxy.toFixed(4) : "n/a"} |`,
      );
    }
    lines.push("");
  }

  lines.push(...HOW_TO_READ);
  return `${lines.join("\n")}\n`;
}
