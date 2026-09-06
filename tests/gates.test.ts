import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseTestSummary, testOutputAccepted } from "../scripts/gate.js";
import { secretsGate } from "../src/gates/secrets.js";
import { languageGate } from "../src/gates/language.js";
import {
  ACKNOWLEDGEMENT_PREFIX, acknowledgedTokens, checkProtectedPaths, protectedPathsSelfTest,
} from "../src/gates/protected-paths.js";
import { PACK_ITEMS, assessPack, renderPack } from "../src/gates/pack.js";
import type { MergeReadinessPack, PackSection } from "../src/gates/pack.js";
import { runGates } from "../src/gates/run.js";
import type { FileUnderReview } from "../src/gates/types.js";

const file = (path: string, content: string): FileUnderReview => ({ path, content });

// A credential shape assembled at runtime, so this test file never contains a
// literal that the secret gate would have to exempt.
const LIVE_KEY = `sk-or-v1-${"9f2a7c1d4b6e8a0c3f5d7b9e1a2c4d6f"}`;

// --- self-tests -----------------------------------------------------------

test("gates: every gate proves it can fail before it is trusted", () => {
  assert.equal(secretsGate.selfTest(), null, "secret scanner self-test must pass");
  assert.equal(languageGate.selfTest(), null, "language scanner self-test must pass");
  assert.equal(protectedPathsSelfTest(), null, "protected-path rules self-test must pass");
});

// --- secrets --------------------------------------------------------------

test("gates: a live credential shape is refused", () => {
  const findings = secretsGate.run([file("src/leak.ts", `const key = "${LIVE_KEY}";`)]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.severity, "blocking");
  assert.equal(findings[0]!.line, 1);
});

test("gates: a finding never reproduces the secret it found", () => {
  const findings = secretsGate.run([file("src/leak.ts", `const key = "${LIVE_KEY}";`)]);
  const rendered = JSON.stringify(findings);
  assert.ok(!rendered.includes(LIVE_KEY), "the gate must not echo the credential it detected");
  assert.match(findings[0]!.evidence ?? "", /chars$/, "evidence is a redacted preview only");
});

test("gates: several credential shapes are recognised", () => {
  const samples: [string, string][] = [
    ["aws", `AKIA${"ABCDEFGHIJKLMNOP"}`],
    ["github", `ghp_${"A1b2C3d4E5f6G7h8I9j0"}`],
    ["anthropic", `sk-ant-${"A1b2C3d4E5f6G7h8"}`],
    // Assembled at runtime so this file holds no literal key marker of its own.
    ["private key", `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}`],
  ];
  for (const [label, value] of samples) {
    const findings = secretsGate.run([file("src/x.ts", `const v = "${value}";`)]);
    assert.ok(findings.length > 0, `${label} shape must be refused`);
  }
});

test("gates: a self-declared fake fixture value is allowed", () => {
  // Tests must be able to assert that redaction works.
  const findings = secretsGate.run([
    file("tests/redact.test.ts", `const SECRET = "sk-or-v1-value-that-must-never-be-printed";`),
  ]);
  assert.equal(findings.length, 0);
});

test("gates: documentation and env examples receive the same secret scan", () => {
  for (const path of [".env.example", "LIVE_EVALUATION.md", "VERIFICATION.md"]) {
    const findings = secretsGate.run([file(path, `OPENROUTER_API_KEY=${LIVE_KEY}`)]);
    assert.equal(findings.length, 1, `${path} must not be a secret-scanning blind spot`);
  }
});

test("gates: a live-looking value is not exempted by an embedded fake word", () => {
  const collision = `sk-or-v1-${"A1b2testC3d4E5f6G7h8I9j0"}`;
  const findings = secretsGate.run([file("src/leak.ts", collision)]);
  assert.equal(findings.length, 1, "an alphanumeric substring is not an explicit fake marker");
});

test("gates: project-scoped OpenAI and fine-grained GitHub token shapes are recognised", () => {
  const values = [
    `sk-${"proj-"}${"A1b2C3d4E5f6G7h8".repeat(2)}`,
    `github_${"pat_"}${"A1b2C3d4E5f6G7h8".repeat(2)}`,
  ];
  for (const value of values) {
    assert.equal(secretsGate.run([file("src/leak.ts", value)]).length, 1);
  }
});

test("gates: ordinary source is not flagged", () => {
  const findings = secretsGate.run([
    file("src/ok.ts", "export const rate = 0.15; // price per million input tokens"),
  ]);
  assert.equal(findings.length, 0);
});

// --- language -------------------------------------------------------------

test("gates: Cyrillic content and Cyrillic file names are refused", () => {
  const content = languageGate.run([file("src/note.ts", "// \u041F\u0440\u0438\u0432\u0435\u0442")]);
  assert.equal(content.length, 1);
  assert.equal(content[0]!.line, 1);

  const named = languageGate.run([file("docs/\u0424\u0430\u0439\u043B.md", "plain ascii")]);
  assert.equal(named.length, 1);
  assert.equal(named[0]!.line, null, "a file-name finding is not anchored to a line");
});

test("gates: English content passes and binary content is skipped", () => {
  assert.equal(languageGate.run([file("src/ok.ts", "const greeting = \"Hello\";")]).length, 0);
  // A NUL byte marks binary content; scanning it line by line is meaningless.
  assert.equal(languageGate.run([file("assets/logo.bin", "before\u0000after")]).length, 0);
});

test("gates: the final commit message is scanned for secrets and Cyrillic", () => {
  const secretReport = runGates({ scope: "staged", commitMessage: `feat: x\n\nkey=${LIVE_KEY}` });
  const secretResult = secretReport.results.find(result => result.gate === "secrets");
  assert.ok(secretResult?.findings.some(finding => finding.file === "COMMIT_EDITMSG"));

  const languageReport = runGates({
    scope: "staged",
    commitMessage: `feat: \u041D\u0435\u0430\u043D\u0433\u043B\u0438\u0439\u0441\u043A\u0438\u0439 \u0442\u0435\u043A\u0441\u0442`,
  });
  const languageResult = languageReport.results.find(result => result.gate === "language");
  assert.ok(languageResult?.findings.some(finding => finding.file === "COMMIT_EDITMSG"));
});

test("gates: pre-commit defers final-message checks to commit-msg", () => {
  const preCommit = readFileSync(".githooks/pre-commit", "utf8");
  const commitMessage = readFileSync(".githooks/commit-msg", "utf8");
  assert.ok(!preCommit.includes("--commit-message-file"));
  assert.ok(commitMessage.includes("--commit-message-file \"$1\""));
});

// --- protected paths ------------------------------------------------------

test("gates: an unannounced prompt or migration change is refused", () => {
  for (const path of ["prompts/judge/core.md", "prompts/prompts.lock.json", "migrations/001_initial.sql"]) {
    const findings = checkProtectedPaths([path], "chore: unrelated tidy-up");
    assert.equal(findings.length, 1, `${path} must require acknowledgement`);
    assert.match(findings[0]!.message, /Protected-change:/);
  }
});

test("gates: an acknowledged protected change passes", () => {
  const message = `feat: sharpen the judge contract\n\n${ACKNOWLEDGEMENT_PREFIX} prompt-change`;
  assert.equal(checkProtectedPaths(["prompts/judge/core.md"], message).length, 0);
});

test("gates: acknowledging one protected area does not unlock another", () => {
  const message = `chore: touch things\n\n${ACKNOWLEDGEMENT_PREFIX} prompt-change`;
  const findings = checkProtectedPaths(["migrations/001_initial.sql"], message);
  assert.equal(findings.length, 1, "a migration change needs its own acknowledgement");
});

test("gates: acknowledgement parsing accepts a list and ignores prose", () => {
  const tokens = acknowledgedTokens(
    `feat: x\n\nSome prose mentioning prompt-change casually.\n${ACKNOWLEDGEMENT_PREFIX} prompt-change, migration`,
  );
  assert.deepEqual([...tokens].sort(), ["migration", "prompt-change"]);

  const prose = acknowledgedTokens("feat: mentions prompt-change but never declares it");
  assert.equal(prose.size, 0, "prose must not count as an acknowledgement");
});

test("gates: unrelated paths are never treated as protected", () => {
  assert.equal(checkProtectedPaths(["src/index.ts", "README.md"], "chore: tidy").length, 0);
});

// --- merge-readiness pack -------------------------------------------------

const section = (item: PackSection["item"], passed: boolean): PackSection => ({
  item,
  statement: null,
  evidence: [{ command: `check ${item}`, result: passed ? "ok" : "failed", passed }],
});

const packOf = (sections: PackSection[]): MergeReadinessPack => ({
  branch: "feat/x", headCommit: "abc1234", baseCommit: "def5678",
  generatedAt: "2026-01-01T00:00:00.000Z", sections,
});

test("pack: an item with no evidence is unproven, never assumed good", () => {
  const assessment = assessPack(packOf([section("functional_completeness", true)]));
  assert.equal(assessment.ready, false);
  assert.ok(assessment.unproven.includes("sound_verification"));
  assert.ok(assessment.unproven.includes("audit_trail"));
});

test("pack: failing evidence marks the item failed rather than unproven", () => {
  const sections = PACK_ITEMS.map(item => section(item, item !== "sound_verification"));
  const withRationale = sections.map(s =>
    s.item === "rationale" ? { ...s, statement: "why this change exists" } : s);
  const assessment = assessPack(packOf(withRationale));
  assert.deepEqual(assessment.failed, ["sound_verification"]);
  assert.equal(assessment.ready, false);
});

test("pack: the rationale is proven by a written statement, not by a command", () => {
  const sections: PackSection[] = PACK_ITEMS.map(item =>
    item === "rationale"
      ? { item, statement: null, evidence: [] }
      : section(item, true));
  assert.ok(assessPack(packOf(sections)).unproven.includes("rationale"),
    "an empty rationale must be unproven even when every command passed");

  const stated = sections.map(s =>
    s.item === "rationale" ? { ...s, statement: "the change exists because ..." } : s);
  const assessment = assessPack(packOf(stated));
  assert.equal(assessment.ready, true);
});

test("pack: a whitespace-only rationale does not count as stated", () => {
  const sections: PackSection[] = PACK_ITEMS.map(item =>
    item === "rationale" ? { item, statement: "   \n  ", evidence: [] } : section(item, true));
  assert.ok(assessPack(packOf(sections)).unproven.includes("rationale"));
});

test("pack: the rendered pack states its verdict and its limits", () => {
  const sections = PACK_ITEMS.map(item =>
    item === "rationale"
      ? { item, statement: "because the course requires a mechanical gate", evidence: [] }
      : section(item, true));
  const pack = packOf(sections);
  const rendered = renderPack(pack, assessPack(pack));
  assert.match(rendered, /ready for the human gate/);
  assert.match(rendered, /does not establish that any live model behaves well/);
  assert.match(rendered, /No paid call is made by any gate/);
  for (const item of PACK_ITEMS) {
    assert.ok(rendered.includes(item.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase())),
      `the pack must render the ${item} section`);
  }
});

test("pack: an unproven item is rendered as unproven", () => {
  const pack = packOf([section("functional_completeness", true)]);
  const rendered = renderPack(pack, assessPack(pack));
  assert.match(rendered, /_Unproven: no evidence was supplied\._/);
  assert.match(rendered, /not ready/);
});

test("pack: the test evidence policy rejects skips, cancellations, todos, and missing summaries", () => {
  const tap = (values: { pass: number; fail?: number; skipped?: number; cancelled?: number; todo?: number }) => [
    `# pass ${values.pass}`,
    `# fail ${values.fail ?? 0}`,
    `# cancelled ${values.cancelled ?? 0}`,
    `# skipped ${values.skipped ?? 0}`,
    `# todo ${values.todo ?? 0}`,
  ].join("\n");

  assert.deepEqual(parseTestSummary(tap({ pass: 165 })), {
    passed: 165, failed: 0, skipped: 0, cancelled: 0, todo: 0,
  });
  assert.equal(testOutputAccepted(tap({ pass: 165 })), true);
  assert.equal(testOutputAccepted(tap({ pass: 164, skipped: 1 })), false);
  assert.equal(testOutputAccepted(tap({ pass: 164, cancelled: 1 })), false);
  assert.equal(testOutputAccepted(tap({ pass: 164, todo: 1 })), false);
  assert.equal(testOutputAccepted("command produced no TAP summary"), false);
});

test("gates: repository CI runs the full pack with PostgreSQL available", () => {
  const workflow = readFileSync(".github/workflows/verification.yml", "utf8");
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /postgres:16-alpine/);
  assert.match(workflow, /npm run gate:merge/);
});
