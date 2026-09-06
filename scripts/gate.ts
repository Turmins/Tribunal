/**
 * Verification gate CLI.
 *
 *   npm run gate                 cheap gates over staged content (pre-commit)
 *   npm run gate -- --tracked    cheap gates over every tracked file
 *   npm run gate:merge           full merge-readiness evidence pack
 *
 * The cheap gates need nobody present and run on every commit. The merge pack
 * additionally executes the expensive checks and records what they returned, so
 * the evidence at the human gate is something that ran rather than something
 * that was claimed.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatGateReport, runGates } from "../src/gates/run.js";
import { assessPack, renderPack } from "../src/gates/pack.js";
import type { Evidence, MergeReadinessPack, PackSection } from "../src/gates/pack.js";

const OUT_DIR = path.join("evaluation", "results");

const git = (args: string[]): string => {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch { return ""; }
};

interface CommandResult { command: string; ok: boolean; summary: string }

/** Run a verification command and capture a short, quotable result. */
function runCommand(
  command: string,
  args: string[],
  summarise: (output: string) => string,
  accepts: (output: string) => boolean = () => true,
): CommandResult {
  const label = [command, ...args].join(" ");
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    return { command: label, ok: accepts(output), summary: summarise(output) };
  } catch (error: unknown) {
    const output = String((error as { stdout?: string })?.stdout ?? "");
    return { command: label, ok: false, summary: summarise(output) || "command failed" };
  }
}

export interface TestSummary {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: number;
  readonly todo: number;
}

export function parseTestSummary(output: string): TestSummary | null {
  const number = (label: string): number | null => {
    const value = new RegExp(`^# ${label} (\\d+)$`, "m").exec(output)?.[1];
    return value === undefined ? null : Number(value);
  };
  const passed = number("pass");
  const failed = number("fail");
  const skipped = number("skipped");
  const cancelled = number("cancelled");
  const todo = number("todo");
  if ([passed, failed, skipped, cancelled, todo].some(value => value === null)) return null;
  return { passed: passed!, failed: failed!, skipped: skipped!, cancelled: cancelled!, todo: todo! };
}

export function testOutputAccepted(output: string): boolean {
  const summary = parseTestSummary(output);
  return summary !== null
    && summary.passed > 0
    && summary.failed === 0
    && summary.skipped === 0
    && summary.cancelled === 0
    && summary.todo === 0;
}

const testSummary = (output: string): string => {
  const summary = parseTestSummary(output);
  return summary
    ? `${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped, ${summary.cancelled} cancelled, ${summary.todo} todo`
    : "no test summary found";
};

function resolveBase(branch: string): { ref: string; commit: string } | null {
  const candidates = [
    process.env.TRIBUNAL_GATE_BASE,
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined,
    branch === "main" ? "origin/main" : "main",
    "origin/main",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const ref of [...new Set(candidates)]) {
    if (!git(["rev-parse", "--verify", `${ref}^{commit}`])) continue;
    const commit = git(["merge-base", ref, "HEAD"]);
    if (commit) return { ref, commit };
  }
  return null;
}

function cheapGates(scope: "staged" | "tracked", commitMessage: string | undefined): number {
  const report = runGates(commitMessage === undefined ? { scope } : { scope, commitMessage });
  console.log(formatGateReport(report));
  return report.ok ? 0 : 1;
}

async function mergePack(): Promise<number> {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const head = git(["rev-parse", "--short", "HEAD"]) || "(unknown)";
  const resolvedBase = resolveBase(branch);
  const base = resolvedBase?.commit ?? "";

  console.log("Collecting merge-readiness evidence. Every item below is executed, not asserted.\n");

  const gateReport = runGates({ scope: "tracked" });
  console.log(formatGateReport(gateReport));
  console.log("");

  const typecheck = runCommand("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"],
    output => (output.trim() ? output.trim().split("\n").slice(0, 3).join(" ") : "no type errors"));
  const tests = runCommand("npm", ["test"], testSummary, testOutputAccepted);
  const build = runCommand("npm", ["run", "build"],
    output => (/built in/.test(output) ? "server and client bundles built" : "build output not recognised"));
  const whitespace = base
    ? runCommand("git", ["diff", "--check", `${base}..HEAD`],
      output => (output.trim() ? "whitespace errors found" : "no whitespace errors in committed branch changes"))
    : { command: "git diff --check <base>..HEAD", ok: false, summary: "base reference unavailable" };
  const cleanTree = runCommand("git", ["status", "--porcelain"],
    output => (output.trim() ? "uncommitted changes are present" : "working tree clean"),
    output => output.trim().length === 0);

  const evidence = (result: CommandResult): Evidence =>
    ({ command: result.command, result: result.summary, passed: result.ok });

  const gateEvidence: Evidence = {
    command: "npm run gate -- --tracked",
    result: gateReport.results
      .map(r => `${r.gate}: ${r.ok ? "pass" : "FAIL"} (${r.selfTestPassed ? "self-test ok" : "SELF-TEST FAILED"})`)
      .join("; "),
    passed: gateReport.ok,
  };

  const commitCount = base ? git(["rev-list", "--count", `${base}..HEAD`]) || "0" : "0";
  const changedFiles = base ? git(["diff", "--stat", `${base}..HEAD`]).split("\n").pop() ?? "" : "";

  const sections: PackSection[] = [
    {
      item: "functional_completeness",
      statement: null,
      evidence: [evidence(build), evidence(typecheck)],
    },
    {
      item: "sound_verification",
      statement: null,
      evidence: [evidence(tests)],
    },
    {
      item: "engineering_hygiene",
      statement: null,
      evidence: [gateEvidence, evidence(whitespace), evidence(cleanTree)],
    },
    {
      item: "rationale",
      // Intent cannot be executed. The commit bodies on this branch are the record.
      statement: (base ? git(["log", "--format=%s", `${base}..HEAD`]) : "").split("\n").filter(Boolean)
        .map(subject => `- ${subject}`).join("\n") || null,
      evidence: [],
    },
    {
      item: "audit_trail",
      statement: null,
      evidence: [{
        command: `git rev-list --count ${base ? base.slice(0, 7) : "<base>"}..HEAD`,
        result: `${commitCount} commit(s) on this branch;${changedFiles ? ` ${changedFiles.trim()}` : " no file changes"}`,
        passed: Boolean(base) && Number(commitCount) > 0,
      }],
    },
  ];

  const pack: MergeReadinessPack = {
    branch, headCommit: head, baseCommit: base ? base.slice(0, 7) : "(unknown)",
    generatedAt: new Date().toISOString(), sections,
  };
  const assessment = assessPack(pack);
  const rendered = renderPack(pack, assessment);

  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `merge-readiness-${head}.md`);
  await writeFile(file, rendered, "utf8");

  console.log(rendered);
  console.log(`Pack written to ${file}`);
  return assessment.ready ? 0 : 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help")) {
    console.log([
      "Verification gates.",
      "",
      "  npm run gate                 cheap gates over staged content",
      "  npm run gate -- --tracked    cheap gates over every tracked file",
      "  npm run gate:merge           full merge-readiness evidence pack",
      "",
      "Cheap gates refuse a commit without anyone present. They scan for",
      "credentials, non-English tracked content, and unannounced changes to",
      "prompts, the prompt lock, or migration history.",
    ].join("\n"));
    return 0;
  }
  if (argv.includes("--merge")) return mergePack();

  const scope = argv.includes("--tracked") ? "tracked" : "staged";
  const messageIndex = argv.indexOf("--commit-message-file");
  let commitMessage: string | undefined;
  if (messageIndex !== -1 && argv[messageIndex + 1]) {
    const { readFileSync } = await import("node:fs");
    try { commitMessage = readFileSync(argv[messageIndex + 1]!, "utf8"); } catch { commitMessage = ""; }
  }
  return cheapGates(scope, commitMessage);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/gate.ts")
  || process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/gate.js");
if (invokedDirectly) process.exit(await main(process.argv.slice(2)));
