import type { FileUnderReview, Finding, Gate } from "./types.js";

/**
 * Language gate.
 *
 * Tracked code, comments, interface copy, and documentation are English only.
 * This was previously enforced by running a scan by hand, and on one occasion
 * that scan reported a clean result because the underlying `grep -P` had failed
 * on the machine's locale and the error was discarded. The result looked
 * identical to a genuine pass.
 *
 * That is the exact failure this gate is built against: the check runs in
 * process with no shell, no locale dependency, and a self-test that refuses to
 * let a silently broken scanner report success.
 */

/** Cyrillic, its supplements, and the historic blocks that render as Cyrillic. */
// Ranges are written as escapes so this file stays pure ASCII and the
// scanner can therefore scan its own source without flagging itself.
const CYRILLIC = /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/;

/** A NUL byte marks content Git treats as binary; scanning it line by line is meaningless. */
const isBinary = (content: string): boolean => content.includes("\u0000");

function scan(file: FileUnderReview): Finding[] {
  const findings: Finding[] = [];
  if (CYRILLIC.test(file.path)) {
    findings.push({
      gate: "language",
      severity: "blocking",
      file: file.path,
      line: null,
      message: "Tracked file name contains Cyrillic characters; tracked content must be English only.",
      evidence: null,
    });
  }
  if (isBinary(file.content)) return findings;
  file.content.split(/\r?\n/).forEach((line, index) => {
    if (!CYRILLIC.test(line)) return;
    findings.push({
      gate: "language",
      severity: "blocking",
      file: file.path,
      line: index + 1,
      message: "Cyrillic text in a tracked file; code, comments, interface copy, and documentation must be English only.",
      evidence: line.trim().slice(0, 80),
    });
  });
  return findings;
}

export const languageGate: Gate = {
  name: "language",
  description: "Refuses Cyrillic text in tracked file names and content.",

  selfTest(): string | null {
    const positive: FileUnderReview = { path: "src/control.ts", content: "const greeting = \"\u041F\u0440\u0438\u0432\u0435\u0442\";" };
    if (scan(positive).length === 0) return "the scanner did not flag known Cyrillic content";

    const named: FileUnderReview = { path: "docs/\u0424\u0430\u0439\u043B.md", content: "plain ascii" };
    if (scan(named).length === 0) return "the scanner did not flag a Cyrillic file name";

    const negative: FileUnderReview = { path: "src/control.ts", content: "const greeting = \"Hello\";" };
    if (scan(negative).length > 0) return "the scanner flagged plain English content";

    return null;
  },

  run(files: readonly FileUnderReview[]): readonly Finding[] {
    return files.flatMap(scan);
  },
};
