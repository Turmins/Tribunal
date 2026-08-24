export const INDICTMENT_START = "<<<INDICTMENT_START>>>";
export const INDICTMENT_END = "<<<INDICTMENT_END>>>";
export const ARGUMENTS_START = "<<<ARGUMENTS_START>>>";
export const ARGUMENTS_END = "<<<ARGUMENTS_END>>>";

const BOUNDARY = /<<<\s*\/?\s*[A-Za-z_]{3,40}\s*>>>/g;

/**
 * Remove wrapper delimiters from untrusted text. Otherwise a user can close the
 * data wrapper and continue with instructions (ARCHITECTURE §11.6, §18.3 E-1).
 * Applied to user fields and advocate argument text (DL-1).
 */
export function stripBoundaries(value: string): string {
  return value.replace(BOUNDARY, " ").replace(/[ \t]{2,}/g, " ").trim();
}

export function wrapIndictment(indictment: { defendant: string; act: string; question: string }): string {
  return [
    INDICTMENT_START,
    `DEFENDANT: ${stripBoundaries(indictment.defendant)}`,
    `ACT: ${stripBoundaries(indictment.act)}`,
    `QUESTION: ${stripBoundaries(indictment.question)}`,
    INDICTMENT_END,
  ].join("\n");
}

export function buildJudgeEvidence(
  args: readonly { instance_no: number; position: string; reasoning: string }[],
): string {
  const body = args
    .map(a => `ADVOCATE ${a.instance_no} (assigned stance: ${a.position}): ${stripBoundaries(a.reasoning)}`)
    .join("\n\n");
  return `\n\n${ARGUMENTS_START}\n${body}\n${ARGUMENTS_END}`;
}
