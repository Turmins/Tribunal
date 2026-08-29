import { config } from "../config.js";
import { MAX_OUTPUT_TOKENS, estimateTokens } from "../pricing.js";
import type { Role } from "../types.js";
import type { StructuredMode } from "../structured-output.js";
import { round } from "./budget.js";

/**
 * Pre-call cost estimation for guarded live runs.
 *
 * The estimate exists to stop a call, so every unknown is resolved in the
 * expensive direction. Two deliberate choices:
 *
 * 1. Prices are never guessed. The repository ships a fallback price table for
 *    the two configured role models only. Estimating an arbitrary `--model`
 *    from those numbers would silently under-charge a more expensive model, so
 *    an unrecognised model must be given explicit prices on the command line.
 * 2. Token counts are approximated from text length, which under-counts dense
 *    text, and output is charged at the full role limit rather than an expected
 *    length.
 */

export class EstimateError extends Error {
  constructor(readonly code: "unknown_model_price" | "price_invalid") {
    super(code);
    this.name = "EstimateError";
  }
}

/** Character-based token estimation is approximate; bias it upward before it gates spending. */
export const INPUT_TOKEN_MARGIN = 1.25;

/**
 * A `json_schema` request may be retried once in `json_object` mode when the
 * model rejects strict schemas (ARCHITECTURE §15.1). A format rejection is
 * normally refused before generation and therefore billed at little or nothing,
 * but the guard assumes the worst case of two fully billed calls.
 */
export const FORMAT_FALLBACK_FACTOR = 2;

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly source: "configured_role_model" | "explicit_override";
}

export interface PriceOverride {
  readonly inputPerMillion?: number | undefined;
  readonly outputPerMillion?: number | undefined;
}

const configuredModel = (role: Role): string =>
  role === "advocate" ? config.ADVOCATE_MODEL : config.JUDGE_MODEL;

const configuredPrice = (role: Role): { inputPerMillion: number; outputPerMillion: number } =>
  role === "advocate"
    ? { inputPerMillion: config.ADVOCATE_INPUT_PRICE_PER_MILLION, outputPerMillion: config.ADVOCATE_OUTPUT_PRICE_PER_MILLION }
    : { inputPerMillion: config.JUDGE_INPUT_PRICE_PER_MILLION, outputPerMillion: config.JUDGE_OUTPUT_PRICE_PER_MILLION };

/**
 * Resolve the price used for estimation. Explicit overrides win; otherwise the
 * model must be the one this role is configured for, because the shipped table
 * describes only that model.
 */
export function resolveModelPrice(role: Role, model: string, override?: PriceOverride): ModelPrice {
  const hasOverride = override?.inputPerMillion !== undefined || override?.outputPerMillion !== undefined;
  if (hasOverride) {
    const input = override?.inputPerMillion;
    const output = override?.outputPerMillion;
    const valid = (value: unknown): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (!valid(input) || !valid(output)) throw new EstimateError("price_invalid");
    return { inputPerMillion: input, outputPerMillion: output, source: "explicit_override" };
  }
  if (model !== configuredModel(role)) throw new EstimateError("unknown_model_price");
  return { ...configuredPrice(role), source: "configured_role_model" };
}

export interface EstimateInput {
  readonly role: Role;
  readonly model: string;
  /** Composed system prompt for the slot. */
  readonly system: string;
  /** Wrapped indictment and, for judges, the evidence block. */
  readonly user: string;
  readonly price: ModelPrice;
  readonly structuredMode: StructuredMode;
}

export interface CostEstimate {
  readonly role: Role;
  readonly model: string;
  readonly estimatedInputTokens: number;
  readonly maxOutputTokens: number;
  readonly singleCallUsd: number;
  /** Worst-case total once a possible format-compatibility retry is included. */
  readonly maxCostUsd: number;
  readonly formatFallbackIncluded: boolean;
  readonly priceSource: ModelPrice["source"];
  readonly inputPricePerMillion: number;
  readonly outputPricePerMillion: number;
}

export function estimateMaxCost(input: EstimateInput): CostEstimate {
  const rawTokens = estimateTokens(`${input.system}\n${input.user}`);
  const estimatedInputTokens = Math.ceil(rawTokens * INPUT_TOKEN_MARGIN);
  const maxOutputTokens = MAX_OUTPUT_TOKENS[input.role];
  const singleCallUsd =
    (estimatedInputTokens * input.price.inputPerMillion + maxOutputTokens * input.price.outputPerMillion) / 1_000_000;
  const fallback = input.structuredMode === "json_schema";
  return {
    role: input.role,
    model: input.model,
    estimatedInputTokens,
    maxOutputTokens,
    singleCallUsd: round(singleCallUsd),
    maxCostUsd: round(singleCallUsd * (fallback ? FORMAT_FALLBACK_FACTOR : 1)),
    formatFallbackIncluded: fallback,
    priceSource: input.price.source,
    inputPricePerMillion: input.price.inputPerMillion,
    outputPricePerMillion: input.price.outputPerMillion,
  };
}
