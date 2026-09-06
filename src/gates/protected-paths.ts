import type { Finding } from "./types.js";

/**
 * Protected paths.
 *
 * Prompts, the prompt lock, and migration history carry product meaning that a
 * passing test suite does not defend. A prompt edit changes what the models are
 * asked without changing any assertion; a migration edit rewrites history that
 * other environments have already applied.
 *
 * These are not forbidden — they are made deliberate. A change here must say so
 * in the commit subject or body, which turns a silent edit into a recorded
 * decision. The gate cannot judge whether the change is correct; it only
 * refuses to let it pass unannounced.
 */

export interface ProtectedRule {
  readonly id: string;
  readonly matches: (path: string) => boolean;
  readonly reason: string;
  /** Token that must appear in the commit message to acknowledge the change. */
  readonly acknowledgement: string;
}

export const PROTECTED_RULES: readonly ProtectedRule[] = [
  {
    id: "prompts",
    matches: path => path.startsWith("prompts/") && path !== "prompts/prompts.lock.json",
    reason: "Prompt content changes model behaviour without changing any test.",
    acknowledgement: "prompt-change",
  },
  {
    id: "prompt_lock",
    matches: path => path === "prompts/prompts.lock.json",
    reason: "The prompt lock is the audit identity of every composed prompt.",
    acknowledgement: "prompt-lock",
  },
  {
    id: "migrations",
    matches: path => path.startsWith("migrations/"),
    reason: "Migration history has already been applied elsewhere and must not be rewritten.",
    acknowledgement: "migration",
  },
];

/**
 * Acknowledgement is spelled as a trailer-like token so it cannot be produced
 * by ordinary prose: `Protected-change: prompt-change`.
 */
export const ACKNOWLEDGEMENT_PREFIX = "Protected-change:";

export function acknowledgedTokens(commitMessage: string): Set<string> {
  const tokens = new Set<string>();
  for (const line of commitMessage.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith(ACKNOWLEDGEMENT_PREFIX.toLowerCase())) continue;
    for (const token of trimmed.slice(ACKNOWLEDGEMENT_PREFIX.length).split(",")) {
      const value = token.trim().toLowerCase();
      if (value) tokens.add(value);
    }
  }
  return tokens;
}

export function checkProtectedPaths(
  changedPaths: readonly string[],
  commitMessage: string,
): Finding[] {
  const acknowledged = acknowledgedTokens(commitMessage);
  const findings: Finding[] = [];
  for (const rule of PROTECTED_RULES) {
    const touched = changedPaths.filter(rule.matches);
    if (touched.length === 0) continue;
    if (acknowledged.has(rule.acknowledgement)) continue;
    for (const path of touched) {
      findings.push({
        gate: "protected-paths",
        severity: "blocking",
        file: path,
        line: null,
        message:
          `${rule.reason} Add "${ACKNOWLEDGEMENT_PREFIX} ${rule.acknowledgement}" to the commit message to record this decision.`,
        evidence: null,
      });
    }
  }
  return findings;
}

/** Prove the rule set can both fire and stay silent. */
export function protectedPathsSelfTest(): string | null {
  const unannounced = checkProtectedPaths(["prompts/judge/core.md"], "chore: tidy");
  if (unannounced.length === 0) return "an unannounced prompt change was not flagged";

  const announced = checkProtectedPaths(
    ["prompts/judge/core.md"],
    `feat: sharpen the judge contract\n\n${ACKNOWLEDGEMENT_PREFIX} prompt-change`,
  );
  if (announced.length > 0) return "an acknowledged prompt change was still flagged";

  const unrelated = checkProtectedPaths(["src/index.ts"], "chore: tidy");
  if (unrelated.length > 0) return "an unrelated path was flagged as protected";

  return null;
}
