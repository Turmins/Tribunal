import type { GuardedOutcome } from "./run.js";

/**
 * Deterministic metrics only.
 *
 * No model is used to score another model here. Every number below is computed
 * by fixed arithmetic over the run outcomes, so re-running the report builder on
 * the same outcomes always produces the same values.
 */

const TOKEN = /[^a-z0-9]+/;

/** Lowercase alphanumeric tokens of length 3 or more, deduplicated. */
export function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(TOKEN).filter(word => word.length >= 3));
}

export function jaccardDistance(a: string, b: string): number {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : round4(1 - shared / union);
}

/**
 * Text-diversity proxy: the mean pairwise Jaccard distance between judge
 * reasonings, over vocabulary alone.
 *
 * This is a PROXY, not evidence of quality. It measures word overlap, so two
 * judges can reach genuinely different reasoning in similar vocabulary and score
 * low, while boilerplate rephrasing scores high. It cannot show that a lens
 * changed how a judge reasoned, only that the wording differed. Treat a low
 * value as a prompt to read the outputs, never as a verdict on the panel.
 */
export function textDiversityProxy(texts: readonly string[]): number | null {
  const usable = texts.filter(text => text.trim().length > 0);
  if (usable.length < 2) return null;
  const distances: number[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      distances.push(jaccardDistance(usable[i]!, usable[j]!));
    }
  }
  return round4(distances.reduce((sum, value) => sum + value, 0) / distances.length);
}

export interface ContractStats {
  readonly attempted: number;
  readonly valid: number;
  readonly successRate: number | null;
  /** Counts keyed by `layer:code`, sorted for stable output. */
  readonly failures: Readonly<Record<string, number>>;
}

export function contractStats(outcomes: readonly GuardedOutcome[]): ContractStats {
  const attempted = outcomes.length;
  const valid = outcomes.filter(o => o.contract.valid).length;
  const failures: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome.contract.valid) continue;
    const key = `${outcome.contract.layer ?? "unknown"}:${outcome.contract.code ?? "unknown"}`;
    failures[key] = (failures[key] ?? 0) + 1;
  }
  return {
    attempted,
    valid,
    successRate: attempted === 0 ? null : round4(valid / attempted),
    failures: sortKeys(failures),
  };
}

/** Advocate-only: share of validated advocates whose position matched the assigned stance. */
export function stanceAdherenceRate(outcomes: readonly GuardedOutcome[]): number | null {
  const advocates = outcomes.filter(o => o.role === "advocate" && o.stanceAdherence !== null);
  if (advocates.length === 0) return null;
  return round4(advocates.filter(o => o.stanceAdherence === true).length / advocates.length);
}

export function sortKeys(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

export const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;
