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
function runCommand(command: string, args: string[], summarise: (output: string) => string): CommandResult {
  const label = [command, ...args].join(" ");
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    });
    return { command: label, ok: true, summary: summarise(output) };
  } catch (error: unknown) {
    const output = String((error as { stdout?: string })?.stdout ?? "");
    return { command: label, ok: false, summary: summarise(output) || "command failed" };
  }
}

const testSummary = (output: string): string => {
  const pass = /^# pass (\d+)$/m.exec(output)?.[1];
  const fail = /^# fail (\d+)$/m.exec(output)?.[1];
  const skipped = /^# skipped (\d+)$/m.exec(output)?.[1];
  return pass ? `${pass} passed, ${fail ?? "?"} failed, ${skipped ?? "?"} skipped` : "no test summary found";
};

function cheapGates(scope: "staged" | "tracked", commitMessage: string | undefined): number {
  const report = runGates(commitMessage === undefined ? { scope } : { scope, commitMessage });
  console.log(formatGateReport(report));
  return report.ok ? 0 : 1;
}

async function mergePack(): Promise<number> {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]) || "(detached)";
  const head = git(["rev-parse", "--short", "HEAD"]) || "(unknown)";
  const base = git(["merge-base", "main", "HEAD"]) || "(unknown)";

  console.log("Collecting merge-readiness evidence. Every item below is executed, not asserted.\n");

  const gateReport = runGates({ scope: "tracked" });
  console.log(formatGateReport(gateReport));
  console.log("");

  const typecheck = runCommand("npx", ["tsc", "-p", "tsconfig.json", "--noEmit"],
    output => (output.trim() ? output.trim().split("\n").slice(0, 3).join(" ") : "no type errors"));
  const tests = runCommand("npm", ["test"], testSummary);
  const build = runCommand("npm", ["run", "build"],
    output => (/built in/.test(output) ? "server and client bundles built" : "build output not recognised"));
  const whitespace = runCommand("git", ["diff", "--check"],
    output => (output.trim() ? "whitespace errors found" : "no whitespace errors"));

  const evidence = (result: CommandResult): Evidence =>
    ({ command: result.command, result: result.summary, passed: result.ok });

  const gateEvidence: Evidence = {
    command: "npm run gate -- --tracked",
    result: gateReport.results
      .map(r => `${r.gate}: ${r.ok ? "pass" : "FAIL"} (${r.selfTestPassed ? "self-test ok" : "SELF-TEST FAILED"})`)
      .join("; "),
    passed: gateReport.ok,
  };

  const commitCount = git(["rev-list", "--count", `${base}..HEAD`]) || "0";
  const changedFiles = git(["diff", "--stat", `${base}..HEAD`]).split("\n").pop() ?? "";

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
      evidence: [gateEvidence, evidence(whitespace)],
    },
    {
      item: "rationale",
      // Intent cannot be executed. The commit bodies on this branch are the record.
      statement: git(["log", "--format=%s", `${base}..HEAD`]).split("\n").filter(Boolean)
        .map(subject => `- ${subject}`).join("\n") || null,
      evidence: [],
    },
    {
      item: "audit_trail",
      statement: null,
      evidence: [{
        command: `git rev-list --count ${base.slice(0, 7)}..HEAD`,
        result: `${commitCount} commit(s) on this branch;${changedFiles ? ` ${changedFiles.trim()}` : " no file changes"}`,
        passed: Number(commitCount) > 0,
      }],
    },
  ];

  const pack: MergeReadinessPack = {
    branch, headCommit: head, baseCommit: base.slice(0, 7),
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
