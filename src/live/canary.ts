import { config } from "../config.js";
import type { ModelProvider, Role } from "../types.js";
import { BudgetLedger, round } from "./budget.js";
import { estimateMaxCost, resolveModelPrice } from "./estimate.js";
import type { CostEstimate, PriceOverride } from "./estimate.js";
import { loadFixtures, selectFixtures } from "./fixtures.js";
import type { Fixture } from "./fixtures.js";
import { buildSlotRequest } from "./request.js";
import { GuardedRunner } from "./run.js";
import type { GuardedOutcome } from "./run.js";

/**
 * One controlled live model call.
 *
 * The canary exists to answer a narrow question — does a real provider call
 * succeed and satisfy the production contract — before anyone considers running
 * the protocol against paid models. It therefore runs a single advocate slot,
 * never the 4+3 protocol, and refuses to run at all unless every gate is
 * explicitly satisfied.
 *
 * Dry-run is the default. `--execute` alone is not enough: an approved limit
 * must be supplied, a key must exist in the environment, and the conservative
 * estimate must fit inside that limit.
 */

export class CanaryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CanaryError";
  }
}

/** The first canary is deliberately limited to one advocate slot. */
export const SUPPORTED_ROLES: readonly Role[] = ["advocate"];
export const MAX_CANARY_CALLS = 1;

export interface CanaryOptions {
  readonly role: Role;
  readonly instance: number;
  readonly model: string;
  readonly fixtureId?: string | undefined;
  readonly execute: boolean;
  readonly maxCostUsd?: number | undefined;
  readonly priceOverride?: PriceOverride | undefined;
}

export interface CanaryPlan {
  readonly mode: "dry-run" | "execute";
  readonly role: Role;
  readonly slot: string;
  readonly instance: number;
  readonly assignedStance: string | null;
  readonly fixtureId: string;
  readonly promptName: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly lensLabel: string | null;
  readonly model: string;
  readonly structuredOutputMode: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly temperature: number;
  readonly estimate: CostEstimate;
  readonly approvedMaxCostUsd: number | null;
  readonly apiKeyPresent: boolean;
  readonly networkCallPerformed: boolean;
}

export interface CanaryReport {
  readonly plan: CanaryPlan;
  readonly outcome: GuardedOutcome | null;
  readonly budget: { approvedUsd: number; spentUsd: number; remainingUsd: number; overrun: boolean } | null;
  readonly callCount: number;
}

export interface CanaryDeps {
  readonly provider: ModelProvider;
  /** Overridable so tests never depend on the real environment. */
  readonly apiKey?: string;
  readonly fixtures?: readonly Fixture[];
}

async function buildPlan(options: CanaryOptions, deps: CanaryDeps): Promise<CanaryPlan> {
  if (!SUPPORTED_ROLES.includes(options.role)) {
    throw new CanaryError(
      "unsupported_role",
      `The canary supports only: ${SUPPORTED_ROLES.join(", ")}. Running judges requires four valid advocate arguments, which is the full protocol.`,
    );
  }
  if (!options.model.trim()) throw new CanaryError("model_required", "--model is required.");

  const all = deps.fixtures ?? await loadFixtures();
  const chosen = selectFixtures(all, options.fixtureId ? [options.fixtureId] : undefined)[0];
  if (!chosen) throw new CanaryError("fixture_missing", "No evaluation fixture is available.");

  const slot = await buildSlotRequest({
    role: options.role,
    instance: options.instance,
    fixture: chosen,
    model: options.model,
  });

  const price = resolveModelPrice(options.role, options.model, options.priceOverride);
  const estimate = estimateMaxCost({
    role: options.role,
    model: options.model,
    system: slot.request.system,
    user: slot.request.user,
    price,
    structuredMode: config.STRUCTURED_OUTPUT,
  });

  return {
    mode: options.execute ? "execute" : "dry-run",
    role: options.role,
    slot: slot.slot,
    instance: options.instance,
    assignedStance: slot.request.stance,
    fixtureId: chosen.id,
    promptName: slot.promptName,
    promptVersion: slot.promptVersion,
    promptHash: slot.promptHash,
    lensLabel: slot.lensLabel,
    model: options.model,
    structuredOutputMode: config.STRUCTURED_OUTPUT,
    maxOutputTokens: slot.request.maxOutputTokens,
    timeoutMs: slot.request.timeoutMs,
    temperature: slot.request.temperature,
    estimate,
    approvedMaxCostUsd: options.maxCostUsd ?? null,
    apiKeyPresent: Boolean((deps.apiKey ?? config.OPENROUTER_API_KEY).trim()),
    networkCallPerformed: false,
  };
}

/** Plan only. Guaranteed to perform no network call. */
export async function planCanary(options: CanaryOptions, deps: CanaryDeps): Promise<CanaryReport> {
  const plan = await buildPlan({ ...options, execute: false }, deps);
  return { plan, outcome: null, budget: null, callCount: 0 };
}

export async function runCanary(options: CanaryOptions, deps: CanaryDeps): Promise<CanaryReport> {
  const plan = await buildPlan(options, deps);
  if (!options.execute) return { plan, outcome: null, budget: null, callCount: 0 };

  // --- gates, in the order that fails most cheaply first --------------------
  if (options.maxCostUsd === undefined) {
    throw new CanaryError("budget_required", "--max-cost-usd is required for --execute.");
  }
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
    throw new CanaryError("budget_invalid", "--max-cost-usd must be a positive number.");
  }
  const key = (deps.apiKey ?? config.OPENROUTER_API_KEY).trim();
  if (!key) {
    throw new CanaryError(
      "api_key_missing",
      "OPENROUTER_API_KEY is not set in the server environment. The canary never accepts a key on the command line.",
    );
  }
  if (plan.estimate.maxCostUsd > options.maxCostUsd) {
    throw new CanaryError(
      "estimate_exceeds_limit",
      `Conservative maximum cost $${plan.estimate.maxCostUsd.toFixed(6)} exceeds the approved limit $${options.maxCostUsd.toFixed(6)}. No request was sent.`,
    );
  }

  const ledger = new BudgetLedger(options.maxCostUsd);
  const runner = new GuardedRunner({ provider: deps.provider, ledger, maxCalls: MAX_CANARY_CALLS });
  const slot = await buildSlotRequest({
    role: options.role,
    instance: options.instance,
    fixture: (deps.fixtures ?? await loadFixtures()).find(f => f.id === plan.fixtureId)!,
    model: options.model,
  });
  const outcome = await runner.run(slot, plan.estimate);

  return {
    plan: { ...plan, networkCallPerformed: true },
    outcome,
    budget: ledger.snapshot(),
    callCount: runner.callCount,
  };
}

/** Safe console summary: no prompt text, no raw response, no credentials. */
export function formatCanary(report: CanaryReport): string {
  const p = report.plan;
  const money = (value: number) => `$${round(value).toFixed(6)}`;
  const lines: string[] = [];

  lines.push(`Tribunal OpenRouter canary — mode: ${p.mode}`);
  lines.push("");
  lines.push(`  role                  ${p.role} (slot ${p.slot}, assigned stance ${p.assignedStance ?? "none"})`);
  lines.push(`  fixture               ${p.fixtureId}`);
  lines.push(`  prompt                ${p.promptName} v${p.promptVersion}`);
  lines.push(`  prompt sha256         ${p.promptHash.slice(0, 16)}…`);
  lines.push(`  lens                  ${p.lensLabel ?? "none"}`);
  lines.push(`  model                 ${p.model}`);
  lines.push(`  structured output     ${p.structuredOutputMode}`);
  lines.push(`  max output tokens     ${p.maxOutputTokens}`);
  lines.push(`  timeout               ${p.timeoutMs} ms`);
  lines.push(`  temperature           ${p.temperature}`);
  lines.push("");
  lines.push(`  estimated input tok   ${p.estimate.estimatedInputTokens} (length estimate x${1.25} margin)`);
  lines.push(`  price source          ${p.estimate.priceSource}`);
  lines.push(`  single call max       ${money(p.estimate.singleCallUsd)}`);
  lines.push(`  conservative max cost ${money(p.estimate.maxCostUsd)}${p.estimate.formatFallbackIncluded ? " (includes one format-fallback retry)" : ""}`);
  lines.push(`  approved limit        ${p.approvedMaxCostUsd === null ? "not supplied" : money(p.approvedMaxCostUsd)}`);
  lines.push(`  API key present       ${p.apiKeyPresent ? "yes" : "no"}`);
  lines.push("");

  if (!report.outcome) {
    lines.push("  NO NETWORK CALL WAS PERFORMED. This was a dry run.");
    lines.push("  To execute one real call: add --execute and --max-cost-usd <limit>.");
    return lines.join("\n");
  }

  const o = report.outcome;
  lines.push(`  RESULT                ${o.ok ? "success" : "failure"}`);
  lines.push(`  model requests made   ${report.callCount} (limit ${MAX_CANARY_CALLS})`);
  lines.push(`  provider / model      ${o.provider ?? "n/a"} / ${o.reportedModel ?? "n/a"}`);
  lines.push(`  contract              ${o.contract.valid ? "valid" : `failed at ${o.contract.layer} ${o.contract.code}`}`);
  if (o.stanceAdherence !== null) lines.push(`  stance adherence      ${o.stanceAdherence ? "matched" : "mismatched"}`);
  lines.push(`  input / output tokens ${o.inputTokens} / ${o.outputTokens}`);
  lines.push(`  cost                  ${money(o.costUsd)}`);
  lines.push(`  latency               ${o.latencyMs === null ? "n/a" : `${o.latencyMs} ms`}`);
  lines.push(`  finish reason         ${o.finishReason ?? "n/a"}`);
  lines.push(`  http attempts         ${o.httpAttempts ?? "n/a"}`);
  lines.push(`  format fallback used  ${o.formatFallback === null ? "n/a" : o.formatFallback ? "yes (json_schema -> json_object)" : "no"}`);
  if (report.budget) {
    lines.push("");
    lines.push(`  approved / spent      ${money(report.budget.approvedUsd)} / ${money(report.budget.spentUsd)}`);
    lines.push(`  remaining             ${money(report.budget.remainingUsd)}${report.budget.overrun ? "  OVERRUN" : ""}`);
  }
  return lines.join("\n");
}
