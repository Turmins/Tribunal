import { execFileSync } from "node:child_process";
import { languageGate } from "./language.js";
import { checkProtectedPaths, protectedPathsSelfTest } from "./protected-paths.js";
import { secretsGate } from "./secrets.js";
import type { FileUnderReview, Finding, Gate, GateResult } from "./types.js";

/**
 * Gate runner.
 *
 * Two scopes exist because they answer different questions:
 *
 * - `staged` runs on what is about to be committed. It must be fast enough that
 *   nobody is tempted to bypass it, so it reads staged blobs directly.
 * - `tracked` runs on everything in the repository. A file can become
 *   non-compliant without being touched — a rule tightens, or an earlier commit
 *   predates the gate — and only a full sweep finds that.
 *
 * A gate whose self-test fails is reported as failed, never as passed. A broken
 * scanner that reports a clean result is the specific failure this design
 * refuses to allow.
 */

export type Scope = "staged" | "tracked";

const git = (args: string[]): string =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Paths that are tracked but whose content is not meaningfully scannable. */
const SKIP_CONTENT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|eot|mp4|mp3)$/i;

export function changedPaths(scope: Scope): string[] {
  const output = scope === "staged"
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    : git(["ls-files", "-z"]);
  return output.split("\0").filter(Boolean);
}

function readContent(scope: Scope, path: string): string | null {
  // Keep an empty record for skipped binary content so the language gate still
  // checks the tracked file name.
  if (SKIP_CONTENT.test(path)) return "";
  try {
    // Staged content, not the working tree: the commit is what is being gated.
    return scope === "staged" ? git(["show", `:${path}`]) : git(["show", `HEAD:${path}`]);
  } catch {
    try { return git(["show", `:${path}`]); } catch { return null; }
  }
}

export function collectFiles(scope: Scope, paths: readonly string[]): FileUnderReview[] {
  const files: FileUnderReview[] = [];
  for (const path of paths) {
    const content = readContent(scope, path);
    if (content === null) continue;
    files.push({ path, content });
  }
  return files;
}

function runGate(gate: Gate, files: readonly FileUnderReview[]): GateResult {
  const selfTestError = gate.selfTest();
  if (selfTestError) {
    return {
      gate: gate.name,
      ok: false,
      examined: 0,
      selfTestPassed: false,
      skippedReason: null,
      findings: [{
        gate: gate.name,
        severity: "blocking",
        file: null,
        line: null,
        message: `Gate self-test failed: ${selfTestError}. A scanner that cannot prove it still detects its own control cannot be trusted to report a clean result.`,
        evidence: null,
      }],
    };
  }
  const findings = gate.run(files);
  return {
    gate: gate.name,
    ok: findings.every(f => f.severity !== "blocking"),
    examined: files.length,
    selfTestPassed: true,
    skippedReason: null,
    findings,
  };
}

export interface GateRunOptions {
  readonly scope: Scope;
  /** Commit message used to check protected-path acknowledgements. */
  readonly commitMessage?: string;
}

export interface GateRunReport {
  readonly scope: Scope;
  readonly ok: boolean;
  readonly results: readonly GateResult[];
  readonly filesExamined: number;
  readonly pathsChanged: number;
}

export function runGates(options: GateRunOptions): GateRunReport {
  const paths = changedPaths(options.scope);
  const files = collectFiles(options.scope, paths);
  const contentUnderReview = options.commitMessage === undefined
    ? files
    : [...files, { path: "COMMIT_EDITMSG", content: options.commitMessage }];
  const results: GateResult[] = [secretsGate, languageGate]
    .map(gate => runGate(gate, contentUnderReview));

  // Protected paths are evaluated against the path list and the commit message,
  // not file content, so they do not fit the content-gate shape.
  const protectedSelfTest = protectedPathsSelfTest();
  const protectedFindings = protectedSelfTest
    ? [{
      gate: "protected-paths", severity: "blocking" as const, file: null, line: null,
      message: `Gate self-test failed: ${protectedSelfTest}.`, evidence: null,
    }]
    : checkProtectedPaths(paths, options.commitMessage ?? "");
  // Acknowledgement lives in the commit message, so a sweep with no message
  // cannot judge it. Skip the check outright rather than reporting findings the
  // caller has no way to answer.
  const acknowledgementUnavailable = options.commitMessage === undefined && protectedSelfTest === null;
  const effectiveFindings = acknowledgementUnavailable ? [] : protectedFindings;
  results.push({
    gate: "protected-paths",
    ok: effectiveFindings.length === 0,
    examined: paths.length,
    selfTestPassed: protectedSelfTest === null,
    skippedReason: acknowledgementUnavailable
      ? "no commit message supplied; acknowledgement is checked at commit time"
      : null,
    findings: effectiveFindings,
  });

  return {
    scope: options.scope,
    ok: results.every(result => result.ok),
    results,
    filesExamined: contentUnderReview.length,
    pathsChanged: paths.length,
  };
}

export function formatGateReport(report: GateRunReport): string {
  const lines: string[] = [];
  lines.push(`Verification gates (${report.scope}): ${report.ok ? "PASS" : "FAIL"}`);
  lines.push(`  ${report.pathsChanged} path(s) changed, ${report.filesExamined} file(s) scanned`);
  lines.push("");
  for (const result of report.results) {
    const status = result.ok ? "pass" : "FAIL";
    const selfTest = result.selfTestPassed ? "self-test ok" : "SELF-TEST FAILED";
    lines.push(`  [${status}] ${result.gate} — ${selfTest}, ${result.examined} examined${result.skippedReason ? ` (${result.skippedReason})` : ""}`);
    for (const finding of result.findings) {
      const where = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ""}` : "(repository)";
      lines.push(`        ${where}`);
      lines.push(`        ${finding.message}`);
      if (finding.evidence) lines.push(`        evidence: ${finding.evidence}`);
    }
  }
  if (!report.ok) {
    lines.push("");
    lines.push("  The commit was refused. Fix the findings above, or record the decision as instructed.");
  }
  return lines.join("\n");
}

export const allFindings = (report: GateRunReport): Finding[] =>
  report.results.flatMap(result => [...result.findings]);
