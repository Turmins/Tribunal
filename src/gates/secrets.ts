import type { FileUnderReview, Finding, Gate } from "./types.js";

/**
 * Secret scanning.
 *
 * A committed secret is exposed for the life of the repository: history is
 * permanent, every clone carries it, and deleting it later does not undo the
 * exposure. This gate therefore blocks rather than warns.
 *
 * Test fixtures need to name credential-shaped strings in order to assert that
 * redaction works. Those are allowed only when the value itself announces that
 * it is not real, so the exemption cannot quietly cover a live key.
 */

interface Pattern {
  readonly id: string;
  readonly regex: RegExp;
  readonly description: string;
}

const PATTERNS: readonly Pattern[] = [
  { id: "openrouter_key", regex: /\bsk-or-v1-[A-Za-z0-9_-]{16,}/g, description: "OpenRouter API key" },
  { id: "openai_key", regex: /\bsk-(?!(?:or-v1|ant)-)[A-Za-z0-9_-]{24,}/g, description: "OpenAI-style API key" },
  { id: "anthropic_key", regex: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, description: "Anthropic API key" },
  { id: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g, description: "AWS access key id" },
  { id: "github_token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g, description: "GitHub token" },
  { id: "google_key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g, description: "Google API key" },
  { id: "private_key_block", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, description: "private key block" },
  { id: "bearer_literal", regex: /\bauthorization"?\s*[:=]\s*"?Bearer\s+[A-Za-z0-9._-]{16,}/gi, description: "hard-coded Authorization header" },
];

/**
 * A credential-shaped literal is tolerated only when it says of itself that it
 * is not real. Anything else is treated as a live secret.
 */
const OBVIOUSLY_FAKE = /(?:^|[-_])(?:not-real|example|placeholder|redacted|dummy|fake|sample|test|probe|must-never|never-print|value-that|x{4,}|0{6,})(?:[-_]|$)/i;

const REDACTED_PREVIEW = (match: string): string =>
  `${match.slice(0, 6)}…${match.length} chars`;

function scan(file: FileUnderReview): Finding[] {
  const findings: Finding[] = [];
  const lines = file.content.split(/\r?\n/);
  for (const pattern of PATTERNS) {
    lines.forEach((line, index) => {
      // A fresh regex per line: the global flag carries lastIndex between calls.
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        const value = match[0];
        if (OBVIOUSLY_FAKE.test(value)) continue;
        findings.push({
          gate: "secrets",
          severity: "blocking",
          file: file.path,
          line: index + 1,
          message: `Possible ${pattern.description}. A committed secret is exposed for the life of the repository; rotate it and remove it from the change.`,
          evidence: REDACTED_PREVIEW(value),
        });
      }
    });
  }
  return findings;
}

export const secretsGate: Gate = {
  name: "secrets",
  description: "Refuses credential-shaped literals in tracked content.",

  selfTest(): string | null {
    const positive: FileUnderReview = {
      path: "src/positive-control.ts",
      // Assembled at runtime so this control cannot itself trip the scanner.
      content: `const key = "sk-or-v1-${"A1b2C3d4E5f6G7h8".repeat(2)}";`,
    };
    if (scan(positive).length === 0) return "the scanner did not flag a known credential shape";

    const negative: FileUnderReview = {
      path: "src/negative-control.ts",
      content: 'const note = "ordinary source with no credentials at all";',
    };
    if (scan(negative).length > 0) return "the scanner flagged ordinary source as a credential";

    const allowed: FileUnderReview = {
      path: "tests/redaction.test.ts",
      content: `const SECRET = "sk-or-v1-value-that-must-never-be-printed";`,
    };
    if (scan(allowed).length > 0) return "the scanner flagged a self-declared fake fixture value";

    return null;
  },

  run(files: readonly FileUnderReview[]): readonly Finding[] {
    return files.flatMap(scan);
  },
};
