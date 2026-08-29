import { ContractError, validateModelOutput } from "../schemas.js";
import type { ModelProvider, Role, Stance } from "../types.js";
import { BudgetLedger, round } from "./budget.js";
import type { CostEstimate } from "./estimate.js";
import type { SlotRequest } from "./request.js";

/**
 * The single place where a guarded live call may happen.
 *
 * Order matters and is enforced here rather than left to callers:
 *
 * 1. the call limit is checked, so a tool can promise "at most N requests";
 * 2. the conservative estimate is reserved against the ledger, which throws
 *    before anything reaches the network when it does not fit;
 * 3. the provider is called;
 * 4. the billed cost is settled immediately, *before* validation, because a
 *    response that violates the contract was still paid for (ARCHITECTURE §17.1);
 * 5. only then is the response validated with the production validator.
 *
 * A failure stays a failure. Nothing in this module converts an error, a
 * truncated response, or a contract violation into a decision.
 */

export class CallLimitError extends Error {
  constructor(readonly limit: number) {
    super("call_limit_reached");
    this.name = "CallLimitError";
  }
}

export interface ContractOutcome {
  readonly valid: boolean;
  readonly layer: string | null;
  readonly code: string | null;
}

export interface GuardedOutcome {
  readonly ok: boolean;
  readonly role: Role;
  readonly slot: string;
  readonly instance: number;
  readonly requestedModel: string;
  readonly reportedModel: string | null;
  readonly provider: string | null;
  readonly promptName: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly assignedStance: Stance | null;
  readonly contract: ContractOutcome;
  /** Advocate only: whether the returned position matched the assigned stance. */
  readonly stanceAdherence: boolean | null;
  /** Judge only: the returned decision. Never combined with any other judge. */
  readonly decision: Stance | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly latencyMs: number | null;
  readonly finishReason: string | null;
  readonly httpAttempts: number | null;
  readonly formatFallback: boolean | null;
  readonly estimatedMaxCostUsd: number;
  /** Length of validated reasoning; the text itself is never persisted. */
  readonly reasoningLength: number | null;
  /**
   * Validated reasoning, kept in memory only so deterministic text metrics can
   * be computed. Report builders must not emit it.
   */
  readonly reasoningText: string | null;
  readonly errorCode: string | null;
}

export interface GuardedRunnerOptions {
  readonly provider: ModelProvider;
  readonly ledger: BudgetLedger;
  /** Hard ceiling on model requests this runner may issue. */
  readonly maxCalls: number;
}

export class GuardedRunner {
  #calls = 0;
  constructor(private readonly options: GuardedRunnerOptions) {}

  get callCount(): number { return this.#calls; }

  async run(slot: SlotRequest, estimate: CostEstimate): Promise<GuardedOutcome> {
    if (this.#calls >= this.options.maxCalls) throw new CallLimitError(this.options.maxCalls);

    // Reserve first: a call that does not fit must never reach the network.
    const reservation = this.options.ledger.reserve(estimate.maxCostUsd);

    const base = {
      role: slot.request.role,
      slot: slot.slot,
      instance: slot.request.instance,
      requestedModel: slot.request.model,
      promptName: slot.promptName,
      promptVersion: slot.promptVersion,
      promptHash: slot.promptHash,
      assignedStance: slot.request.stance,
      estimatedMaxCostUsd: estimate.maxCostUsd,
    } as const;

    this.#calls += 1;
    let billed: { inputTokens: number; outputTokens: number; costUsd: number } | null = null;
    try {
      const result = await this.options.provider.complete(slot.request);
      billed = { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd };
      this.options.ledger.settle(reservation, result.costUsd);

      const shared = {
        ...base,
        reportedModel: result.model,
        provider: result.provider,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costUsd: round(result.costUsd),
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
        httpAttempts: result.httpAttempts ?? null,
        formatFallback: result.formatFallback ?? null,
      };

      try {
        // A truncated response is a transport-layer failure, not a short answer.
        if (result.finishReason === "length") throw new ContractError("L0", "truncated_response");
        const normalized = validateModelOutput(result.rawBody, slot.request.role, slot.request.stance);
        const value = "position" in normalized ? normalized.position : normalized.decision;
        return {
          ...shared,
          ok: true,
          contract: { valid: true, layer: null, code: null },
          stanceAdherence: slot.request.role === "advocate" ? value === slot.request.stance : null,
          decision: slot.request.role === "judge" ? value : null,
          reasoningLength: normalized.reasoning.length,
          reasoningText: normalized.reasoning,
          errorCode: null,
        };
      } catch (error: unknown) {
        const contract = error instanceof ContractError
          ? { valid: false, layer: error.layer, code: error.code }
          : { valid: false, layer: "L0", code: "validation_error" };
        return {
          ...shared,
          ok: false,
          contract,
          stanceAdherence: null,
          decision: null,
          reasoningLength: null,
          reasoningText: null,
          errorCode: contract.code,
        };
      }
    } catch (error: unknown) {
      // The provider itself failed, so nothing was reported as billed.
      if (billed === null) this.options.ledger.release(reservation);
      return {
        ...base,
        ok: false,
        reportedModel: null,
        provider: null,
        contract: { valid: false, layer: "L0", code: "provider_error" },
        stanceAdherence: null,
        decision: null,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: null,
        finishReason: null,
        httpAttempts: null,
        formatFallback: null,
        reasoningLength: null,
        reasoningText: null,
        errorCode: "provider_error",
      };
    }
  }
}
