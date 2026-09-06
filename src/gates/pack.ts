/**
 * The Merge-Readiness Pack.
 *
 * Evidence needs a settled form at the gate. The pack establishes five things
 * for a change: functional completeness, sound verification, engineering
 * hygiene, the rationale, and a complete audit trail.
 *
 * Each item is shown by evidence, never by assertion. That distinction is the
 * whole point: this module records the command that was run and what it
 * returned. Nothing here can be satisfied by a claim, and an item with no
 * evidence is reported as unproven rather than assumed good.
 */

export type PackItem =
  | "functional_completeness"
  | "sound_verification"
  | "engineering_hygiene"
  | "rationale"
  | "audit_trail";

export const PACK_ITEMS: readonly PackItem[] = [
  "functional_completeness",
  "sound_verification",
  "engineering_hygiene",
  "rationale",
  "audit_trail",
];

export const PACK_ITEM_TITLES: Readonly<Record<PackItem, string>> = {
  functional_completeness: "Functional completeness",
  sound_verification: "Sound verification",
  engineering_hygiene: "Engineering hygiene",
  rationale: "Rationale",
  audit_trail: "Audit trail",
};

export interface Evidence {
  /** Exactly what was run, so a reader can repeat it. */
  readonly command: string;
  /** What it returned, trimmed to the part that matters. */
  readonly result: string;
  readonly passed: boolean;
}

export interface PackSection {
  readonly item: PackItem;
  readonly evidence: readonly Evidence[];
  /** Prose the change author must supply; evidence cannot be generated for intent. */
  readonly statement: string | null;
}

export interface MergeReadinessPack {
  readonly branch: string;
  readonly headCommit: string;
  readonly baseCommit: string;
  readonly generatedAt: string;
  readonly sections: readonly PackSection[];
}

export interface PackAssessment {
  readonly ready: boolean;
  readonly unproven: readonly PackItem[];
  readonly failed: readonly PackItem[];
}

/**
 * An item is proven only when it carries at least one piece of evidence and
 * every piece passed. Items needing human judgement additionally require a
 * written statement: a green test run cannot establish why a change was made.
 */
const REQUIRES_STATEMENT: readonly PackItem[] = ["rationale"];

export function assessPack(pack: MergeReadinessPack): PackAssessment {
  const unproven: PackItem[] = [];
  const failed: PackItem[] = [];
  for (const item of PACK_ITEMS) {
    const section = pack.sections.find(s => s.item === item);
    if (!section) { unproven.push(item); continue; }
    // Intent cannot be demonstrated by running something, so the rationale is
    // proven by a written statement. Everything else needs executed evidence.
    const proven = REQUIRES_STATEMENT.includes(item)
      ? Boolean(section.statement?.trim())
      : section.evidence.length > 0;
    if (!proven) { unproven.push(item); continue; }
    if (section.evidence.some(evidence => !evidence.passed)) failed.push(item);
  }
  return { ready: unproven.length === 0 && failed.length === 0, unproven, failed };
}

export function renderPack(pack: MergeReadinessPack, assessment: PackAssessment): string {
  const lines: string[] = [];
  lines.push("# Merge-Readiness Pack");
  lines.push("");
  lines.push(`- Branch: \`${pack.branch}\``);
  lines.push(`- Head: \`${pack.headCommit}\``);
  lines.push(`- Base: \`${pack.baseCommit}\``);
  lines.push(`- Generated: ${pack.generatedAt}`);
  lines.push(`- Assessment: **${assessment.ready ? "ready for the human gate" : "not ready"}**`);
  if (assessment.failed.length) {
    lines.push(`- Failed: ${assessment.failed.map(i => PACK_ITEM_TITLES[i]).join(", ")}`);
  }
  if (assessment.unproven.length) {
    lines.push(`- Unproven: ${assessment.unproven.map(i => PACK_ITEM_TITLES[i]).join(", ")}`);
  }
  lines.push("");
  lines.push("Every item below is established by evidence. An item with no evidence is");
  lines.push("reported as unproven; it is never assumed to be satisfied.");
  lines.push("");

  for (const item of PACK_ITEMS) {
    const section = pack.sections.find(s => s.item === item);
    lines.push(`## ${PACK_ITEM_TITLES[item]}`);
    lines.push("");
    if (!section || (section.evidence.length === 0 && !section.statement)) {
      lines.push("_Unproven: no evidence was supplied._");
      lines.push("");
      continue;
    }
    if (section.statement) {
      lines.push(section.statement);
      lines.push("");
    }
    for (const evidence of section.evidence) {
      lines.push(`- \`${evidence.command}\` — **${evidence.passed ? "pass" : "FAIL"}**`);
      lines.push(`  ${evidence.result}`);
    }
    lines.push("");
  }

  lines.push("## What this pack does not establish");
  lines.push("");
  lines.push("- It does not establish that any live model behaves well. No paid call is made by any gate.");
  lines.push("- It does not replace review. Cheap gates run first so that human attention is never spent on work the tests already reject.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}
