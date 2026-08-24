import { config } from "./config.js";
import type { Role } from "./types.js";

const PRICES: Record<Role, { input: number; output: number }> = {
  advocate: { input: config.ADVOCATE_INPUT_PRICE_PER_MILLION, output: config.ADVOCATE_OUTPUT_PRICE_PER_MILLION },
  judge: { input: config.JUDGE_INPUT_PRICE_PER_MILLION, output: config.JUDGE_OUTPUT_PRICE_PER_MILLION },
};

export const MAX_OUTPUT_TOKENS: Record<Role, number> = { advocate: 900, judge: 1200 };

export function tableCost(role: Role, inputTokens: number, outputTokens: number): number {
  const price = PRICES[role];
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/**
 * Provider usage is authoritative; the price table is used only when the
 * provider omits cost (ARCHITECTURE §17.1, decision D-05). A zero cost for a
 * live call would defeat case budgets, so zero is treated as "not reported".
 */
export function resolveCost(
  role: Role,
  providerCost: number | string | undefined | null,
  inputTokens: number,
  outputTokens: number,
): { costUsd: number; source: "provider" | "table" } {
  const reported = typeof providerCost === "string" ? Number(providerCost) : providerCost;
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return { costUsd: reported, source: "provider" };
  }
  return { costUsd: tableCost(role, inputTokens, outputTokens), source: "table" };
}

/** Worst-case judge-stage cost: the full output limit for all three judges (ARCHITECTURE §16.3). */
export function worstCaseJudgeStage(estimatedInputTokens: number): number {
  return 3 * tableCost("judge", estimatedInputTokens, MAX_OUTPUT_TOKENS.judge);
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
