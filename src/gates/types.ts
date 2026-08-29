/**
 * Verification gates.
 *
 * A gate is a mechanical check that refuses a change without anyone present.
 * The project already had these checks; it ran them by hand, which is the
 * failure mode this module exists to remove. A check that depends on someone
 * remembering to run it is not a control.
 *
 * Every gate must carry a self-test. A scanner that silently stops matching
 * reports a clean result forever, which is worse than having no scanner at all
 * because it is trusted. Before a gate is allowed to pass, it must first prove
 * it can fail: it is handed a known-bad sample it must flag and a known-good
 * sample it must not.
 */

export type Severity = "blocking" | "advisory";

export interface Finding {
  /** Gate that produced this finding. */
  readonly gate: string;
  readonly severity: Severity;
  /** Repository-relative path, or null for a repository-wide finding. */
  readonly file: string | null;
  /** 1-indexed line, when the finding is anchored to one. */
  readonly line: number | null;
  readonly message: string;
  /** Never include the matched secret itself. */
  readonly evidence: string | null;
}

export interface GateResult {
  readonly gate: string;
  readonly ok: boolean;
  readonly findings: readonly Finding[];
  /** What the gate actually examined, so an empty result is auditable. */
  readonly examined: number;
  readonly selfTestPassed: boolean;
  readonly skippedReason: string | null;
}

export interface FileUnderReview {
  readonly path: string;
  readonly content: string;
}

export interface Gate {
  readonly name: string;
  readonly description: string;
  /**
   * Prove the gate can fail. Must return an error message when the gate does
   * not flag its own positive control, or does flag its negative control.
   */
  selfTest(): string | null;
  run(files: readonly FileUnderReview[]): readonly Finding[];
}

export const blocking = (findings: readonly Finding[]): Finding[] =>
  findings.filter(f => f.severity === "blocking");
