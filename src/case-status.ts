export type TerminalStatus = "completed" | "partial" | "failed";
export interface StageOutcome { status: TerminalStatus; reason: string | null }

export const TERMINAL_STATUSES = ["completed", "partial", "failed", "cancelled"] as const;
export const isTerminal = (status: string): boolean =>
  (TERMINAL_STATUSES as readonly string[]).includes(status);

export const JUDGE_SLOTS = 3;
export const ADVOCATE_SLOTS = 4;

/**
 * Terminal case status based on the number of successful judge runs.
 * Zero successful decisions is a failure, not a partial result: "partial" would
 * incorrectly tell the user that at least one result exists (ARCHITECTURE §9.1, §16.2).
 */
export function judgeStageOutcome(successCount: number): StageOutcome {
  if (successCount >= JUDGE_SLOTS) return { status: "completed", reason: null };
  if (successCount <= 0) return { status: "failed", reason: "judge_failure" };
  return { status: "partial", reason: "judge_failure" };
}
