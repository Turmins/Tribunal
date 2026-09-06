import { config } from "../config.js";
import type { ModelProvider, Role } from "../types.js";
import { BudgetError, BudgetLedger, round } from "./budget.js";
import { estimateMaxCost, resolveModelPrice } from "./estimate.js";
import type { CostEstimate, PriceOverride } from "./estimate.js";
import { loadFixtures, selectFixtures } from "./fixtures.js";
import type { Fixture } from "./fixtures.js";
import { buildSlotRequest } from "./request.js";
import type { SlotRequest } from "./request.js";
import { GuardedRunner } from "./run.js";
import type { GuardedOutcome } from "./run.js";

/**
 * Deterministic evaluation harness for comparing models on a fixed corpus.
 *
 * Structure of a run: every selected model is measured on every selected
 * fixture, across the four advocate slots and the three judge slots. Judges read
 * the fixture's fixed reference arguments rather than the advocates just
 * produced, so a model's judge behaviour is measured against identical evidence
 * and is not contaminated by variance in its own advocates.
 *
 * The harness measures. It does not rank models, score decisions, or use a model
 * to grade another model: every reported number is fixed arithmetic over run
 * outcomes.
 */

export class EvaluationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "EvaluationError";
  }
}

export const EVALUATED_SLOTS: readonly { role: Role; instance: number }[] = [
  { role: "advocate", instance: 1 },
  { role: "advocate", instance: 2 },
  { role: "advocate", instance: 3 },
  { role: "advocate", instance: 4 },
  { role: "judge", instance: 1 },
  { role: "judge", instance: 2 },
  { role: "judge", instance: 3 },
];

export interface EvaluationOptions {
  readonly models: readonly string[];
  readonly roles?: readonly Role[] | undefined;
  readonly fixtureIds?: readonly string[] | undefined;
  readonly execute: boolean;
  readonly maxCostUsd?: number | undefined;
  /** Explicit prices keyed by exact model id. */
  readonly priceOverrides?: Readonly<Record<string, PriceOverride>> | undefined;
  readonly concurrency?: number | undefined;
}

export interface EvaluationDeps {
  readonly provider: ModelProvider;
  readonly apiKey?: string;
  readonly fixtures?: readonly Fixture[];
}

export interface PlannedCall {
  readonly model: string;
  readonly fixtureId: string;
  readonly slot: SlotRequest;
  readonly estimate: CostEstimate;
}

export interface EvaluationRun {
  readonly mode: "dry-run" | "execute";
  readonly models: readonly string[];
  readonly fixtureIds: readonly string[];
  readonly roles: readonly Role[];
  readonly planned: readonly PlannedCall[];
  readonly plannedMaxCostUsd: number;
  readonly outcomes: readonly GuardedOutcome[];
  /** Fixture id per outcome, aligned by index into `outcomes`. */
  readonly outcomeFixtures: readonly string[];
  readonly budget: { approvedUsd: number; spentUsd: number; remainingUsd: number; overrun: boolean } | null;
  readonly callCount: number;
  readonly stoppedReason: string | null;
  readonly structuredOutputMode: string;
  readonly apiKeyPresent: boolean;
}

export async function planEvaluation(options: EvaluationOptions, deps: EvaluationDeps): Promise<PlannedCall[]> {
  if (options.models.length === 0) throw new EvaluationError("models_required", "--models requires at least one model id.");
  if (new Set(options.models).size !== options.models.length) {
    throw new EvaluationError("duplicate_model", "--models must not contain duplicate model ids.");
  }
  if (options.fixtureIds && new Set(options.fixtureIds).size !== options.fixtureIds.length) {
    throw new EvaluationError("duplicate_fixture", "--fixtures must not contain duplicate fixture ids.");
  }
  const roles = options.roles ?? (["advocate", "judge"] as const);
  const all = deps.fixtures ?? await loadFixtures();
  const fixtures = selectFixtures(all, options.fixtureIds);
  if (fixtures.length === 0) throw new EvaluationError("fixtures_required", "No fixtures selected.");

  const planned: PlannedCall[] = [];
  // Deterministic order: model, then fixture, then protocol slot order.
  for (const model of [...options.models].sort()) {
    for (const fixture of fixtures) {
      for (const entry of EVALUATED_SLOTS) {
        if (!roles.includes(entry.role)) continue;
        const slot = await buildSlotRequest({
          role: entry.role, instance: entry.instance, fixture, model,
        });
        const price = resolveModelPrice(entry.role, model, options.priceOverrides?.[model]);
        planned.push({
          model,
          fixtureId: fixture.id,
          slot,
          estimate: estimateMaxCost({
            role: entry.role, model, system: slot.request.system, user: slot.request.user,
            price, structuredMode: config.STRUCTURED_OUTPUT,
          }),
        });
      }
    }
  }
  return planned;
}

export async function runEvaluation(options: EvaluationOptions, deps: EvaluationDeps): Promise<EvaluationRun> {
  const roles = [...(options.roles ?? (["advocate", "judge"] as const))];
  const planned = await planEvaluation(options, deps);
  const plannedMaxCostUsd = round(planned.reduce((sum, call) => sum + call.estimate.maxCostUsd, 0));
  const apiKeyPresent = Boolean((deps.apiKey ?? config.OPENROUTER_API_KEY).trim());
  const fixtureIds = [...new Set(planned.map(call => call.fixtureId))];
  const models = [...new Set(planned.map(call => call.model))];

  const base = {
    models, fixtureIds, roles, planned, plannedMaxCostUsd,
    structuredOutputMode: config.STRUCTURED_OUTPUT, apiKeyPresent,
  } as const;

  if (!options.execute) {
    return { ...base, mode: "dry-run", outcomes: [], outcomeFixtures: [], budget: null, callCount: 0, stoppedReason: null };
  }

  if (options.maxCostUsd === undefined) {
    throw new EvaluationError("budget_required", "--max-cost-usd is required for --execute.");
  }
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
    throw new EvaluationError("budget_invalid", "--max-cost-usd must be a positive number.");
  }
  if (!apiKeyPresent) {
    throw new EvaluationError(
      "api_key_missing",
      "OPENROUTER_API_KEY is not set in the server environment. The harness never accepts a key on the command line.",
    );
  }

  const ledger = new BudgetLedger(options.maxCostUsd);
  const runner = new GuardedRunner({ provider: deps.provider, ledger, maxCalls: planned.length });
  const collected: { index: number; outcome: GuardedOutcome; fixtureId: string }[] = [];
  let stoppedReason: string | null = null;
  let next = 0;

  // First cause wins. Concurrent lanes can fail for different reasons in the
  // same moment; overwriting would make the reported cause depend on scheduling.
  const stop = (reason: string): void => { if (stoppedReason === null) stoppedReason = reason; };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stoppedReason !== null) return;
      const index = next;
      if (index >= planned.length) return;
      next += 1;
      const call = planned[index]!;
      try {
        const outcome = await runner.run(call.slot, call.estimate);
        collected.push({ index, outcome, fixtureId: call.fixtureId });
        if (outcome.costUncertain) { stop("provider_cost_unknown"); return; }
      } catch (error: unknown) {
        // A reservation that does not fit stops the whole evaluation before the
        // call is made. Cost already incurred stays in the ledger and the report.
        if (error instanceof BudgetError) { stop(error.code); return; }
        throw error;
      }
    }
  };

  const lanes = Math.max(1, Math.min(options.concurrency ?? 1, config.MAX_INFLIGHT_MODEL_CALLS));
  await Promise.all(Array.from({ length: lanes }, () => worker()));

  // Concurrency finishes out of order; restore planned order for a stable report.
  collected.sort((a, b) => a.index - b.index);
  return {
    ...base,
    mode: "execute",
    outcomes: collected.map(entry => entry.outcome),
    outcomeFixtures: collected.map(entry => entry.fixtureId),
    budget: ledger.snapshot(),
    callCount: runner.callCount,
    stoppedReason,
  };
}
